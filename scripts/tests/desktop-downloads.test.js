/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { updateDesktopDownloads } from '../../.github/scripts/update-desktop-downloads.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('Desktop installer alias', () => {
  let directory, options, source, current, feed, failure;
  const writes = [];

  function metadata(file) {
    const bytes = readFileSync(file);
    return {
      name: basename(file),
      state: 'uploaded',
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'desktop-downloads-'));
    options = {
      assets: directory,
      version: '1.2.3',
      repository: 'example/qwen-code',
    };
    const names = [
      'Qwen-Code-Desktop-arm64.dmg',
      'Qwen-Code-Desktop-x64.dmg',
      'Qwen-Code-Desktop_1.2.3_x64-setup.exe',
      'Qwen-Code-Desktop_1.2.3_amd64.AppImage',
      'Qwen-Code-Desktop_1.2.3_aarch64.AppImage',
      'Qwen-Code-Desktop_1.2.3_amd64.deb',
      'Qwen-Code-Desktop_1.2.3_arm64.deb',
      'desktop-latest.json',
      'latest.yml',
      'Qwen-Code-Desktop-arm64.zip',
      'Qwen-Code-Desktop-aarch64-apple-darwin.app.tar.gz',
      'Qwen-Code-Desktop_1.2.3_x64-setup.exe.sig',
    ];
    for (const name of names)
      writeFileSync(join(directory, name), `Current ${name}`);
    source = {
      draft: false,
      prerelease: false,
      assets: names.map((name) => metadata(join(directory, name))),
    };
    current = undefined;
    feed = '1.2.3';
    failure = undefined;
    writes.length = 0;
    vi.mocked(execFileSync)
      .mockReset()
      .mockImplementation((command, args, config) => {
        expect(command).toBe('gh');
        if (args[0] === 'api') {
          if (args[1].endsWith('/desktop-v1.2.3'))
            return JSON.stringify(source);
          expect(args[1]).toBe(
            'repos/example/qwen-code/releases/tags/desktop-stable',
          );
          if (!current || current.draft)
            throw Object.assign(new Error('not found'), {
              stderr: failure === 'api' ? '(HTTP 403)' : '(HTTP 404)',
            });
          return JSON.stringify(current);
        }
        if (args[1] === 'view') {
          const found = args[2] === 'desktop-v1.2.3' ? source : current;
          if (!found)
            throw Object.assign(new Error('release not found'), {
              stderr: failure === 'api' ? '(HTTP 403)' : 'release not found\n',
            });
          return JSON.stringify({
            assets: found.assets,
            isDraft: found.draft,
            isPrerelease: found.prerelease,
          });
        }
        if (args[1] === 'download') {
          expect(args.slice(2)).toEqual([
            'desktop-latest',
            '--repo',
            options.repository,
            '--pattern',
            'desktop-latest.json',
            '--output',
            '-',
          ]);
          return JSON.stringify({ version: feed });
        }
        writes.push({ args, input: config.input });
        if (args[1] === 'edit' && args[2] === 'desktop-latest') return '';
        // All asset mutations must stay off the legacy updater release.
        expect(args[2]).toBe('desktop-stable');
        if (args[1] === 'create')
          current = { draft: true, prerelease: false, assets: [] };
        if (args[1] === 'create' || args[1] === 'upload') {
          if (failure === 'upload') throw new Error('upload failed');
          for (const file of args.slice(3, args.indexOf('--repo'))) {
            const item = metadata(file);
            current.assets = current.assets.filter(
              (asset) => asset.name !== item.name,
            );
            current.assets.push(item);
          }
        } else if (args[1] === 'delete-asset') {
          current.assets = current.assets.filter(
            (asset) => asset.name !== args[3],
          );
        } else if (args[1] === 'edit') {
          if (failure === 'notes') throw new Error('notes failed');
          current.draft = false;
          current.prerelease = false;
        }
        return '';
      });
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('publishes only verified installers, labels the feed, and keeps repository Latest unchanged', async () => {
    await updateDesktopDownloads(options);
    expect(current.assets).toHaveLength(7);
    expect(current.draft).toBe(false);
    expect(
      current.assets.every((asset) =>
        /(?:\.dmg|-setup\.exe|\.AppImage|\.deb)$/.test(asset.name),
      ),
    ).toBe(true);
    const create = writes.find(({ args }) => args[1] === 'create');
    expect(create.args).toContain('--draft');
    expect(create.args).toContain('--latest=false');
    const edit = writes.find(
      ({ args }) => args[1] === 'edit' && args[2] === 'desktop-stable',
    );
    expect(edit.args).toContain('--latest=false');
    expect(edit.input).toContain('/tag/desktop-v1.2.3');
    expect(edit.input).toContain(
      '/download/desktop-stable/Qwen-Code-Desktop_1.2.3_x64-setup.exe',
    );
    expect(writes.at(-1).input).toContain('Legacy Electron');
    expect(writes.at(-1).input).toContain('/tag/desktop-stable');
  });

  it('replaces same-named DMGs and prunes older installers only after upload', async () => {
    current = {
      draft: false,
      prerelease: false,
      assets: [
        { ...source.assets[0], digest: 'sha256:old' },
        { ...source.assets[2], name: 'Qwen-Code-Desktop_1.2.2_x64-setup.exe' },
      ],
    };
    await updateDesktopDownloads(options);
    expect(current.assets).toEqual(source.assets.slice(0, 7));
    expect(writes.findIndex(({ args }) => args[1] === 'upload')).toBeLessThan(
      writes.findIndex(({ args }) => args[1] === 'delete-asset'),
    );
    expect(writes.find(({ args }) => args[1] === 'upload').args).toContain(
      '--clobber',
    );
  });

  it('can rerun without uploading or deleting matching installers', async () => {
    await updateDesktopDownloads(options);
    writes.length = 0;
    await updateDesktopDownloads(options);
    expect(writes.every(({ args }) => args[1] === 'edit')).toBe(true);
  });

  it('keeps previous installers and release notes when an upload fails', async () => {
    current = {
      draft: false,
      prerelease: false,
      assets: [{ ...source.assets[2], name: 'old-setup.exe' }],
    };
    failure = 'upload';
    await expect(updateDesktopDownloads(options)).rejects.toThrow(
      'upload failed',
    );
    expect(current.assets[0].name).toBe('old-setup.exe');
    expect(writes).toHaveLength(1);
  });

  it('keeps old download links available if updating the alias notes fails', async () => {
    current = {
      draft: false,
      prerelease: false,
      assets: [{ ...source.assets[2], name: 'old-setup.exe' }],
    };
    failure = 'notes';
    await expect(updateDesktopDownloads(options)).rejects.toThrow(
      'notes failed',
    );
    expect(current.assets.some((asset) => asset.name === 'old-setup.exe')).toBe(
      true,
    );
    await expect(
      updateDesktopDownloads({ ...options, verify: true }),
    ).rejects.toThrow('only the current stable installers');
  });

  it.each(['1.2.4', '1.2.2'])(
    'refuses a version different from the stable feed (%s)',
    async (version) => {
      feed = version;
      await expect(updateDesktopDownloads(options)).rejects.toThrow(
        'downloads unchanged',
      );
      expect(writes).toEqual([]);
    },
  );

  it.each(['draft', 'prerelease'])(
    'rejects a %s source release',
    async (field) => {
      source[field] = true;
      await expect(updateDesktopDownloads(options)).rejects.toThrow(
        'not a published stable release',
      );
      expect(writes).toEqual([]);
    },
  );

  it('does not treat an API failure as an absent alias', async () => {
    failure = 'api';
    await expect(updateDesktopDownloads(options)).rejects.toThrow('not found');
    expect(writes).toEqual([]);
  });

  it('refuses local installer bytes that differ from the versioned release', async () => {
    writeFileSync(join(directory, source.assets[0].name), 'wrong DMG');
    await expect(updateDesktopDownloads(options)).rejects.toThrow(
      'Local installer differs',
    );
    expect(writes).toEqual([]);
  });

  it('verifies the advertised files without writes', async () => {
    current = {
      draft: false,
      prerelease: false,
      assets: source.assets.slice(0, 7),
    };
    await updateDesktopDownloads({ ...options, verify: true });
    expect(writes).toEqual([]);
  });

  it.each(['missing', 'digest', 'extra', 'draft'])(
    'blocks promotion if advertised downloads are %s',
    async (kind) => {
      current = {
        draft: false,
        prerelease: false,
        assets: structuredClone(source.assets.slice(0, 7)),
      };
      if (kind === 'missing') current.assets.pop();
      if (kind === 'digest') current.assets[0].digest = 'sha256:old';
      if (kind === 'extra') current.assets.push(source.assets[7]);
      if (kind === 'draft') current.draft = true;
      await expect(
        updateDesktopDownloads({ ...options, verify: true }),
      ).rejects.toThrow();
      expect(writes).toEqual([]);
    },
  );
});

it('advertises the maintained installer release instead of the updater feed', () => {
  const readme = readFileSync('README.md', 'utf8');
  const links = [
    ...readme.matchAll(
      /https:\/\/github\.com\/QwenLM\/qwen-code\/releases\/tag\/desktop-(?:latest|stable)/g,
    ),
  ];
  expect(links).toHaveLength(2);
  expect(links.map((match) => match[0])).toEqual([
    'https://github.com/QwenLM/qwen-code/releases/tag/desktop-stable',
    'https://github.com/QwenLM/qwen-code/releases/tag/desktop-stable',
  ]);
});

it('publishes downloads only behind the stable feed guard and verifies them before OSS promotion', () => {
  const release = parse(
    readFileSync('.github/workflows/desktop-release.yml', 'utf8'),
  );
  const sync = parse(
    readFileSync('.github/workflows/sync-desktop-to-oss.yml', 'utf8'),
  );
  const publish = release.jobs.publish.steps.find(
    (step) => step.name === 'Update stable updater feed',
  );
  expect(publish.if).toContain(
    'inputs.draft == false && inputs.prerelease == false',
  );
  expect(publish.run).toContain('update-desktop-downloads.mjs');
  expect(publish.run.indexOf('update-desktop-downloads.mjs')).toBeGreaterThan(
    publish.run.indexOf('will not replace newer stable feed'),
  );
  const check = Object.values(sync.jobs)
    .flatMap((job) => job.steps)
    .find(
      (step) =>
        step.name === 'Check whether release matches GitHub stable feed',
    );
  expect(check.run).toContain('update-desktop-downloads.mjs');
  expect(check.run).toContain('--verify');
  expect(check.run.indexOf('--verify')).toBeLessThan(
    check.run.indexOf('matches=true'),
  );
});
