/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mediaFixture, pdfFixture } from './provider-media-fixtures.js';
import './provider-media-read-probe.mjs';
import {
  PROVIDER_MEDIA_FIXTURES_PREFIX,
  PROVIDER_MEDIA_PROBE_PREFIX,
  stopFixtureProcess,
} from './provider-media-process-cleanup.mjs';

for (const alreadyExited of [false, true]) {
  test(
    `fixture cleanup handles ${alreadyExited ? 'an already signaled' : 'a running'} child`,
    { timeout: 3000 },
    async () => {
      for (const graceful of [false, true]) {
        const child = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { stdio: 'ignore' },
        );
        try {
          await once(child, 'spawn');
          if (alreadyExited) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
            assert.equal(child.exitCode, null);
            assert.equal(child.signalCode, 'SIGKILL');
          }
          let shutdowns = 0;
          await stopFixtureProcess(
            child,
            graceful
              ? () => {
                  shutdowns++;
                  child.kill('SIGTERM');
                }
              : undefined,
          );
          assert.equal(shutdowns, graceful && !alreadyExited ? 1 : 0);
          assert.equal(child.exitCode, null);
          assert.equal(
            child.signalCode,
            graceful && !alreadyExited ? 'SIGTERM' : 'SIGKILL',
          );
        } finally {
          await stopFixtureProcess(child);
        }
      }
    },
  );
}

test(
  'fixture cleanup kills a child that accepts shutdown but never exits',
  { timeout: 3000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    await once(child, 'spawn');
    try {
      await stopFixtureProcess(child, () => {}, 50);
      assert.equal(child.signalCode, 'SIGKILL');
    } finally {
      await stopFixtureProcess(child);
    }
  },
);

test('worker read probe appends evidence across process generations', async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), PROVIDER_MEDIA_PROBE_PREFIX),
  );
  try {
    const file = path.join(temporary, 'proof.pdf');
    await writeFile(file, 'proof');
    const probe = new URL('./provider-media-read-probe.mjs', import.meta.url)
      .href;
    const code = 'require("node:fs").readFileSync(process.argv[1])';
    execFileSync(process.execPath, ['--import', probe, '-e', code, file]);
    const first = await readFile(
      path.join(temporary, '.provider-media-reads.json'),
      'utf8',
    );
    execFileSync(process.execPath, ['--import', probe, '-e', code, file]);
    const second = await readFile(
      path.join(temporary, '.provider-media-reads.json'),
      'utf8',
    );
    assert(second.startsWith(first));
    assert(second.length > first.length);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('worker read probe preserves execFile promisify stdout and stderr', async () => {
  const result = await promisify(execFile)(process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err');",
  ]);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

test('real image fixtures decode with the expected MIME and dimensions', async () => {
  for (const name of ['png', 'jpeg', 'webp', 'gif'] as const) {
    const fixture = await mediaFixture(name);
    const metadata = await sharp(fixture.bytes).metadata();
    assert.equal(`image/${metadata.format}`, fixture.mime);
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 6);
    assert(!(await mediaFixture(name, true)).bytes.equals(fixture.bytes));
  }
});

test('real PDF fixtures distinguish text extraction, Poppler rendering and size refusal', async () => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), PROVIDER_MEDIA_FIXTURES_PREFIX),
  );
  try {
    const text = path.join(temporary, 'text.pdf');
    const scan = path.join(temporary, 'scan.pdf');
    await writeFile(text, pdfFixture(true));
    await writeFile(scan, pdfFixture(false));
    assert(
      execFileSync('pdftotext', [text, '-'], { encoding: 'utf8' }).includes(
        'provider media text proof',
      ),
    );
    assert.equal(
      execFileSync('pdftotext', [scan, '-'], { encoding: 'utf8' }).trim(),
      '',
    );
    execFileSync(
      'pdftoppm',
      ['-f', '1', '-singlefile', '-png', scan, path.join(temporary, 'page')],
      { stdio: 'pipe' },
    );
    const metadata = await sharp(
      await readFile(path.join(temporary, 'page.png')),
    ).metadata();
    assert.equal(metadata.format, 'png');
    assert(metadata.width! > 8 && metadata.height! > 6);
    const oversized = await mediaFixture('pdf-too-large');
    assert(oversized.bytes.length > 576 * 1024);
    const large = path.join(temporary, 'large.pdf');
    await writeFile(large, oversized.bytes);
    assert(
      execFileSync('pdfinfo', [large], { encoding: 'utf8' }).includes('Pages:'),
    );
    const native = await mediaFixture('native-pdf');
    assert(
      native.bytes.length > 560 * 1024 && native.bytes.length < 576 * 1024,
    );
    await writeFile(large, native.bytes);
    assert(
      execFileSync('pdfinfo', [large], { encoding: 'utf8' }).includes('Pages:'),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
