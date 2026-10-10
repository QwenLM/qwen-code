/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SOURCE_BYTES } from './contracts.js';
import { ReportStore } from './report-store.js';

const roots: string[] = [];
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qwen-report-store-'));
  roots.push(root);
  return root;
}
async function source(root: string): Promise<void> {
  await writeFile(
    join(root, 'report.json'),
    await readFile(new URL('../test-fixtures/mixed.json', import.meta.url)),
  );
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('workspace report snapshots', () => {
  it('persists immutable evidence across overwrite, deletion and restart', async () => {
    const root = await workspace();
    await source(root);
    const store = await ReportStore.create(root);
    const first = await store.importReport('report.json');
    expect(await store.importReport('./report.json')).toEqual(first);
    await writeFile(
      join(root, 'report.json'),
      await readFile(
        new URL('../test-fixtures/statuses.json', import.meta.url),
      ),
    );
    const second = await store.importReport('report.json');
    expect(second.reportId).not.toBe(first.reportId);
    await rm(join(root, 'report.json'));
    const restarted = await ReportStore.create(root);
    expect(await restarted.load(first.reportId)).toEqual(first);
    expect(await restarted.load(second.reportId)).toEqual(second);
  });

  it('converges concurrent imports without replacing the winning snapshot', async () => {
    const root = await workspace();
    await source(root);
    const stores = await Promise.all(
      Array.from({ length: 8 }, () => ReportStore.create(root)),
    );
    const snapshots = await Promise.all(
      stores.map((store) => store.importReport('report.json')),
    );
    expect(
      snapshots.every(
        (snapshot) => JSON.stringify(snapshot) === JSON.stringify(snapshots[0]),
      ),
    ).toBe(true);
    expect(
      await readdir(join(root, '.qwen/test-failure-explorer/reports')),
    ).toEqual([`${snapshots[0].reportId}.json`]);
  });

  it('scopes IDs to canonical workspace roots and refuses copied foreign snapshots', async () => {
    const [a, b] = await Promise.all([workspace(), workspace()]);
    await Promise.all([source(a), source(b)]);
    const [storeA, storeB] = await Promise.all([
      ReportStore.create(a),
      ReportStore.create(b),
    ]);
    const [snapshotA, snapshotB] = await Promise.all([
      storeA.importReport('report.json'),
      storeB.importReport('report.json'),
    ]);
    expect(snapshotA.reportId).not.toBe(snapshotB.reportId);
    const directory = join(b, '.qwen/test-failure-explorer/reports');
    await writeFile(
      join(directory, `${snapshotA.reportId}.json`),
      await readFile(
        join(
          a,
          '.qwen/test-failure-explorer/reports',
          `${snapshotA.reportId}.json`,
        ),
      ),
    );
    await expect(storeB.load(snapshotA.reportId)).rejects.toMatchObject({
      code: 'REPORT_UNAVAILABLE',
    });
    const alias = join(b, 'alias');
    await symlink(a, alias, 'dir');
    expect(
      (await (await ReportStore.create(alias)).importReport('report.json'))
        .reportId,
    ).toBe(snapshotA.reportId);
  });

  it.each([
    undefined,
    'relative',
    '${workspacePath}',
    '/no-such-qwen-test-workspace',
  ])('rejects invalid startup root %s', async (root) => {
    await expect(ReportStore.create(root)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });

  it('refuses traversal, absolute paths, non-JSON and escaping symlinks', async () => {
    const [root, outside] = await Promise.all([workspace(), workspace()]);
    await source(outside);
    const store = await ReportStore.create(root);
    for (const path of [
      '../report.json',
      '..\\report.json',
      join(outside, 'report.json'),
      'report.txt',
    ]) {
      await expect(store.importReport(path)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_WORKSPACE',
      });
    }
    await symlink(join(outside, 'report.json'), join(root, 'escape.json'));
    await expect(store.importReport('escape.json')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
    expect(await readdir(root)).toEqual(['escape.json']);
  });

  it('resolves an internal source alias without duplicating the snapshot', async () => {
    const root = await workspace();
    await source(root);
    await symlink(join(root, 'report.json'), join(root, 'alias.json'));
    const store = await ReportStore.create(root);
    expect(await store.importReport('alias.json')).toEqual(
      await store.importReport('report.json'),
    );
  });

  it('rejects incomplete JSON, invalid UTF-8, oversized sources and directories without writing cache', async () => {
    const root = await workspace();
    const store = await ReportStore.create(root);
    for (const bytes of [
      Buffer.from('{'),
      Buffer.from([0xff]),
      Buffer.from('{}'),
    ]) {
      await writeFile(join(root, 'bad.json'), bytes);
      await expect(store.importReport('bad.json')).rejects.toMatchObject({
        code: 'INVALID_REPORT',
      });
    }
    await writeFile(join(root, 'big.json'), Buffer.alloc(MAX_SOURCE_BYTES + 1));
    await expect(store.importReport('big.json')).rejects.toMatchObject({
      code: 'REPORT_TOO_LARGE',
    });
    await mkdir(join(root, 'directory.json'));
    await expect(store.importReport('directory.json')).rejects.toMatchObject({
      code: 'INVALID_REPORT',
    });
    expect(await readdir(root)).not.toContain('.qwen');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const root = await workspace();
      execFileSync('mkfifo', [join(root, 'pipe.json')]);
      await expect(
        (await ReportStore.create(root)).importReport('pipe.json'),
      ).rejects.toMatchObject({ code: 'INVALID_REPORT' });
    },
  );

  it('rejects snapshot expansion beyond the cache bound before creating cache', async () => {
    const root = await workspace();
    const data = JSON.parse(
      await readFile(
        new URL('../test-fixtures/mixed.json', import.meta.url),
        'utf8',
      ),
    );
    const file = data.testResults[0];
    file.name = 'p'.repeat(10_000);
    file.assertionResults = Array.from(
      { length: 3_000 },
      () => file.assertionResults[0],
    );
    data.testResults = [file];
    await writeFile(join(root, 'report.json'), JSON.stringify(data));
    await expect(
      (await ReportStore.create(root)).importReport('report.json'),
    ).rejects.toMatchObject({ code: 'REPORT_TOO_LARGE' });
    expect(await readdir(root)).toEqual(['report.json']);
  });

  it('rejects a symlinked cache and never writes outside the workspace', async () => {
    const [root, outside] = await Promise.all([workspace(), workspace()]);
    await source(root);
    await symlink(outside, join(root, '.qwen'), 'dir');
    await expect(
      (await ReportStore.create(root)).importReport('report.json'),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('detects snapshot tampering and leaves the corrupt existing ID untouched', async () => {
    const root = await workspace();
    await source(root);
    const store = await ReportStore.create(root);
    const snapshot = await store.importReport('report.json');
    const path = join(
      root,
      '.qwen/test-failure-explorer/reports',
      `${snapshot.reportId}.json`,
    );
    const altered = JSON.stringify({
      ...snapshot,
      importedAt: '2020-01-01T00:00:00.000Z',
    });
    await writeFile(path, altered);
    await expect(store.load(snapshot.reportId)).rejects.toMatchObject({
      code: 'REPORT_UNAVAILABLE',
    });
    await expect(store.importReport('report.json')).rejects.toMatchObject({
      code: 'REPORT_UNAVAILABLE',
    });
    expect(await readFile(path, 'utf8')).toBe(altered);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an actually unwritable cache without claiming an import',
    async () => {
      const root = await workspace();
      await source(root);
      const directory = join(root, '.qwen');
      await mkdir(directory);
      await chmod(directory, 0o500);
      try {
        await expect(
          (await ReportStore.create(root)).importReport('report.json'),
        ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );

  it('fails safely for an unusable cache and ignores interrupted temporary files', async () => {
    const root = await workspace();
    await source(root);
    await writeFile(join(root, '.qwen'), 'not a directory');
    const store = await ReportStore.create(root);
    await expect(store.importReport('report.json')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
    await rm(join(root, '.qwen'));
    const directory = join(root, '.qwen/test-failure-explorer/reports');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.import-interrupted.tmp'), '{');
    const snapshot = await store.importReport('report.json');
    expect(await store.load(snapshot.reportId)).toEqual(snapshot);
    await expect(store.load(`r1_${'a'.repeat(64)}`)).rejects.toMatchObject({
      code: 'REPORT_UNAVAILABLE',
    });
    await expect(store.load('../bad')).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    });
  });

  it('does not publish an import cancelled before reading', async () => {
    const root = await workspace();
    await source(root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      (await ReportStore.create(root)).importReport(
        'report.json',
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual(['report.json']);
  });
});
