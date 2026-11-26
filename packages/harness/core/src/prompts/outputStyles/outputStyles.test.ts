/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  BUILTIN_OUTPUT_STYLES,
} from './builtin.js';
import { loadOutputStylesFromDir } from './loader.js';
import {
  getAvailableOutputStyleDefinitions,
  getAvailableOutputStyles,
  getAllOutputStyles,
  resolveOutputStyleWithForce,
} from './resolve.js';
import { CONFIG_DIR } from '../../utils/paths.js';
import type { LoadedPlugin } from '../../plugins/types.js';
import type { OutputStyleConfig } from './types.js';

function mkTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outputstyle-test-'));
}

function writeStyle(dir: string, fileName: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content, 'utf-8');
}

function fakeLoadedPlugin(
  name: string,
  outputStylesPath?: string,
): LoadedPlugin {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manifest: { name, version: 'local', description: '' } as any,
    path: outputStylesPath ? path.dirname(outputStylesPath) : '/fake',
    source: 'local',
    repository: 'local',
    enabled: true,
    outputStylesPath,
  };
}

function productStyle(
  name: string,
  overrides: Partial<OutputStyleConfig> = {},
): OutputStyleConfig {
  return {
    name,
    source: 'built-in',
    description: `${name} description`,
    prompt: `${name} body`,
    ...overrides,
  };
}

// Shared fixture scaffolding: gives every test its own tmp cwd plus a
// separate tmp home used as the "user" settings root.
interface TestFixtures {
  tmpCwd: string;
  tmpHome: string;
}

function setupFixtures(): TestFixtures {
  const tmpCwd = mkTmpWorkspace();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'outputstyle-home-'));
  return { tmpCwd, tmpHome };
}

function teardownFixtures(f: TestFixtures): void {
  fs.rmSync(f.tmpCwd, { recursive: true, force: true });
  fs.rmSync(f.tmpHome, { recursive: true, force: true });
}

describe('built-in output styles', () => {
  it('has default as null', () => {
    expect(BUILTIN_OUTPUT_STYLES[DEFAULT_OUTPUT_STYLE_NAME]).toBeNull();
  });

  it('exposes Explanatory and Learning with well-formed configs', () => {
    const explanatory = BUILTIN_OUTPUT_STYLES['Explanatory'];
    expect(explanatory).not.toBeNull();
    expect(explanatory?.source).toBe('built-in');
    expect(explanatory?.keepCodingInstructions).toBe(true);
    expect(explanatory?.prompt).toContain('Explanatory Style Active');

    const learning = BUILTIN_OUTPUT_STYLES['Learning'];
    expect(learning).not.toBeNull();
    expect(learning?.source).toBe('built-in');
    expect(learning?.prompt).toContain('Learning Style Active');
  });
});

describe('output style merging', () => {
  let tmpCwd: string;
  let fixtures: TestFixtures;

  beforeEach(() => {
    fixtures = setupFixtures();
    tmpCwd = fixtures.tmpCwd;
  });

  afterEach(() => teardownFixtures(fixtures));

  it('merges built-ins + injected project styles', async () => {
    const dir = path.join(tmpCwd, CONFIG_DIR, 'output-styles');
    writeStyle(dir, 'Mine.md', `---\nname: Mine\n---\nBody.`);
    const resourceOutputStyles = await loadOutputStylesFromDir(
      dir,
      'projectSettings',
    );
    const all = await getAllOutputStyles({ resourceOutputStyles });
    expect(all['default']).toBeNull();
    expect(all['Explanatory']).not.toBeNull();
    expect(all['Learning']).not.toBeNull();
    expect(all['Mine']?.source).toBe('projectSettings');
  });

  it('project-level styles override user-level on name collision', async () => {
    const userDir = path.join(fixtures.tmpHome, CONFIG_DIR, 'output-styles');
    writeStyle(
      userDir,
      'Shared.md',
      `---\nname: Shared\ndescription: user\n---\nuser body`,
    );
    const projectDir = path.join(tmpCwd, CONFIG_DIR, 'output-styles');
    writeStyle(
      projectDir,
      'Shared.md',
      `---\nname: Shared\ndescription: project\n---\nproject body`,
    );
    const userStyles = await loadOutputStylesFromDir(userDir, 'userSettings');
    const projectStyles = await loadOutputStylesFromDir(
      projectDir,
      'projectSettings',
    );
    const all = await getAllOutputStyles({
      resourceOutputStyles: [...userStyles, ...projectStyles],
    });
    expect(all['Shared']?.description).toBe('project');
    expect(all['Shared']?.source).toBe('projectSettings');
  });

  it('preserves same-name project and user definitions for discovery', async () => {
    const userDir = path.join(fixtures.tmpHome, CONFIG_DIR, 'output-styles');
    writeStyle(
      userDir,
      'Shared.md',
      `---\nname: Shared\ndescription: user\n---\nuser body`,
    );
    const projectDir = path.join(tmpCwd, CONFIG_DIR, 'output-styles');
    writeStyle(
      projectDir,
      'Shared.md',
      `---\nname: Shared\ndescription: project\n---\nproject body`,
    );
    const userStyles = await loadOutputStylesFromDir(userDir, 'userSettings');
    const projectStyles = await loadOutputStylesFromDir(
      projectDir,
      'projectSettings',
    );

    const definitions = await getAvailableOutputStyleDefinitions({
      resourceOutputStyles: [...userStyles, ...projectStyles],
    });
    const sharedDefinitions = definitions.filter(
      (style) => style.name === 'Shared',
    );

    expect(sharedDefinitions).toHaveLength(2);
    expect(sharedDefinitions.map((style) => style.source)).toEqual([
      'userSettings',
      'projectSettings',
    ]);
  });

  it('returns null for default / unknown / undefined', async () => {
    expect(await resolveOutputStyleWithForce(undefined)).toBeNull();
    expect(await resolveOutputStyleWithForce('default')).toBeNull();
    expect(await resolveOutputStyleWithForce('does-not-exist')).toBeNull();
  });

  it('resolves a built-in by name', async () => {
    const learning = await resolveOutputStyleWithForce('Learning');
    expect(learning).not.toBeNull();
    expect(learning?.source).toBe('built-in');
  });

  it('resolves a hidden product style by exact name without advertising it', async () => {
    const productOutputStyles = [
      productStyle('Product-Hidden', {
        isUserVisible: false,
        keepCodingInstructions: true,
        prompt: 'hidden product body',
      }),
    ];

    const resolved = await resolveOutputStyleWithForce('Product-Hidden', {
      productOutputStyles,
    });
    const available = await getAvailableOutputStyles({ productOutputStyles });
    const definitions = await getAvailableOutputStyleDefinitions({
      productOutputStyles,
    });

    expect(resolved?.name).toBe('Product-Hidden');
    expect(resolved?.prompt).toBe('hidden product body');
    expect(available['Product-Hidden']).toBeUndefined();
    expect(available[DEFAULT_OUTPUT_STYLE_NAME]).toBeNull();
    expect(available['Explanatory']).toBeDefined();
    expect(
      definitions.some((style) => style.name === 'Product-Hidden'),
    ).toBe(false);
  });

  it('does not allow external styles to expose or replace a hidden product style', async () => {
    const productOutputStyles = [
      productStyle('Product-Hidden', {
        isUserVisible: false,
        prompt: 'hidden product body',
      }),
    ];
    const projectDir = path.join(tmpCwd, CONFIG_DIR, 'output-styles');
    writeStyle(
      projectDir,
      'Product.md',
      `---\nname: Product-Hidden\n---\nexternal body`,
    );
    const resourceOutputStyles = await loadOutputStylesFromDir(
      projectDir,
      'projectSettings',
    );

    const resolved = await resolveOutputStyleWithForce('Product-Hidden', {
      productOutputStyles,
      resourceOutputStyles,
    });
    const available = await getAvailableOutputStyles({
      productOutputStyles,
      resourceOutputStyles,
    });
    const definitions = await getAvailableOutputStyleDefinitions({
      productOutputStyles,
      resourceOutputStyles,
    });

    expect(resolved?.source).toBe('built-in');
    expect(resolved?.prompt).toBe('hidden product body');
    expect(available['Product-Hidden']).toBeUndefined();
    expect(
      definitions.some((style) => style.name === 'Product-Hidden'),
    ).toBe(false);
  });

  it('treats visible product styles as built-ins that external styles may override', async () => {
    const productOutputStyles = [
      productStyle('Product-Visible', { prompt: 'product body' }),
    ];

    const available = await getAvailableOutputStyles({ productOutputStyles });
    expect(available['Product-Visible']?.source).toBe('built-in');
    expect(available['Product-Visible']?.prompt).toBe('product body');

    const projectDir = path.join(tmpCwd, CONFIG_DIR, 'output-styles');
    writeStyle(
      projectDir,
      'Visible.md',
      `---\nname: Product-Visible\ndescription: external\n---\nexternal body`,
    );
    const resourceOutputStyles = await loadOutputStylesFromDir(
      projectDir,
      'projectSettings',
    );

    const resolved = await resolveOutputStyleWithForce('Product-Visible', {
      productOutputStyles,
      resourceOutputStyles,
    });
    expect(resolved?.source).toBe('projectSettings');
    expect(resolved?.prompt).toContain('external body');
  });
});

describe('extension-contributed output styles', () => {
  it('loadOutputStylesFromDir tags source=plugin and pluginName with namespace', async () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-fixture-'));
    try {
      writeStyle(
        extDir,
        'Thing.md',
        `---\nname: Thing\ndescription: from ext\n---\nBody`,
      );
      const styles = await loadOutputStylesFromDir(extDir, 'plugin', 'my-ext');
      expect(styles).toHaveLength(1);
      expect(styles[0]?.name).toBe('my-ext:Thing');
      expect(styles[0]?.source).toBe('plugin');
      expect(styles[0]?.pluginName).toBe('my-ext');
    } finally {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  });

  it('non-plugin styles are NOT namespaced', async () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-fixture-'));
    try {
      writeStyle(extDir, 'MyStyle.md', `---\nname: MyStyle\n---\nBody`);
      const styles = await loadOutputStylesFromDir(extDir, 'userSettings');
      expect(styles).toHaveLength(1);
      expect(styles[0]?.name).toBe('MyStyle');
    } finally {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  });
});

describe('plugin output styles via LoadedPlugin path', () => {
  let fixtures: TestFixtures;

  beforeEach(() => {
    fixtures = setupFixtures();
  });

  afterEach(() => teardownFixtures(fixtures));

  it('loads plugin output styles from LoadedPlugin outputStylesPath', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-os-'));
    const osDir = path.join(pluginDir, 'output-styles');
    try {
      writeStyle(
        osDir,
        'PlugStyle.md',
        `---\nname: PlugStyle\ndescription: from plugin\n---\nplugin body`,
      );
      const plugin = fakeLoadedPlugin('my-plugin', osDir);
      const all = await getAllOutputStyles({ plugins: [plugin] });
      expect(all['my-plugin:PlugStyle']).not.toBeNull();
      expect(all['my-plugin:PlugStyle']?.source).toBe('plugin');
      expect(all['my-plugin:PlugStyle']?.pluginName).toBe('my-plugin');
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('recursively loads plugin output styles from subdirectories', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-rec-'));
    const osDir = path.join(pluginDir, 'output-styles');
    try {
      writeStyle(osDir, 'TopLevel.md', `---\nname: TopLevel\n---\ntop body`);
      writeStyle(
        path.join(osDir, 'sub'),
        'Nested.md',
        `---\nname: Nested\n---\nnested body`,
      );
      const plugin = fakeLoadedPlugin('rec-plugin', osDir);
      const all = await getAllOutputStyles({ plugins: [plugin] });
      expect(all['rec-plugin:TopLevel']).not.toBeNull();
      expect(all['rec-plugin:Nested']).not.toBeNull();
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('disabled plugins are skipped', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dis-'));
    const osDir = path.join(pluginDir, 'output-styles');
    try {
      writeStyle(osDir, 'Ghost.md', `---\nname: Ghost\n---\nbody`);
      const plugin = fakeLoadedPlugin('disabled', osDir);
      plugin.enabled = false;
      const all = await getAllOutputStyles({ plugins: [plugin] });
      expect(all['disabled:Ghost']).toBeUndefined();
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('loads a single-file output style declared via outputStylesPaths', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sf-'));
    const styleFile = path.join(pluginDir, 'extra.md');
    try {
      fs.writeFileSync(
        styleFile,
        `---\nname: ExtraStyle\ndescription: from manifest single file\n---\nextra body`,
      );
      const plugin = fakeLoadedPlugin('sf-plugin');
      plugin.outputStylesPaths = [styleFile];
      const all = await getAllOutputStyles({ plugins: [plugin] });
      expect(all['sf-plugin:ExtraStyle']).toBeDefined();
      expect(all['sf-plugin:ExtraStyle']?.source).toBe('plugin');
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});

describe('resolveOutputStyleWithForce', () => {
  let fixtures: TestFixtures;

  beforeEach(() => {
    fixtures = setupFixtures();
  });

  afterEach(() => teardownFixtures(fixtures));

  it('returns forced plugin style even when user picks a different name', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-force-'));
    const osDir = path.join(pluginDir, 'output-styles');
    try {
      writeStyle(
        osDir,
        'Forced.md',
        `---\nname: Forced\nforce-for-plugin: true\n---\nforced body`,
      );
      const plugin = fakeLoadedPlugin('force-plugin', osDir);
      const resolved = await resolveOutputStyleWithForce(
        'Learning', // user wants Learning
        { plugins: [plugin] },
      );
      expect(resolved).not.toBeNull();
      expect(resolved?.name).toBe('force-plugin:Forced');
      expect(resolved?.forceForPlugin).toBe(true);
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('falls back to normal resolution when no forced styles exist', async () => {
    const resolved = await resolveOutputStyleWithForce('Learning');
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe('built-in');
    expect(resolved?.name).toBe('Learning');
  });

  it('returns null for default style when no forced styles exist', async () => {
    const resolved = await resolveOutputStyleWithForce('default');
    expect(resolved).toBeNull();
  });

  it('picks first forced style when multiple plugins force', async () => {
    const pluginDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-f1-'));
    const osDir1 = path.join(pluginDir1, 'output-styles');
    const pluginDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-f2-'));
    const osDir2 = path.join(pluginDir2, 'output-styles');
    try {
      writeStyle(
        osDir1,
        'First.md',
        `---\nname: First\nforce-for-plugin: true\n---\nfirst body`,
      );
      writeStyle(
        osDir2,
        'Second.md',
        `---\nname: Second\nforce-for-plugin: true\n---\nsecond body`,
      );
      const plugin1 = fakeLoadedPlugin('p1', osDir1);
      const plugin2 = fakeLoadedPlugin('p2', osDir2);
      const resolved = await resolveOutputStyleWithForce('default', {
        plugins: [plugin1, plugin2],
      });
      expect(resolved).not.toBeNull();
      // First plugin's forced style should win
      expect(resolved?.name).toBe('p1:First');
    } finally {
      fs.rmSync(pluginDir1, { recursive: true, force: true });
      fs.rmSync(pluginDir2, { recursive: true, force: true });
    }
  });

  it('force-for-plugin: false does NOT force the style', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-nf-'));
    const osDir = path.join(pluginDir, 'output-styles');
    try {
      writeStyle(
        osDir,
        'NotForced.md',
        `---\nname: NotForced\nforce-for-plugin: false\n---\nnot forced body`,
      );
      const plugin = fakeLoadedPlugin('nf-plugin', osDir);
      const resolved = await resolveOutputStyleWithForce('default', {
        plugins: [plugin],
      });
      // No forced style, and 'default' maps to null
      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});
