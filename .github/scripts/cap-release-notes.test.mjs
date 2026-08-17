import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_BODY_CHARS, prepareReleaseNotes } from './cap-release-notes.mjs';

const SCRIPT = fileURLToPath(
  new URL('./cap-release-notes.mjs', import.meta.url),
);

const context = {
  tag: 'v0.21.2',
  previousTag: 'v0.21.1',
  repo: 'QwenLM/qwen-code',
  serverUrl: 'https://github.com',
};

describe('release notes body preparation', () => {
  it('leaves a body that fits untouched', () => {
    const body = "## What's Changed\n* one thing\n";

    const result = prepareReleaseNotes({ ...context, body });

    assert.equal(result.body, body.trim());
    assert.equal(result.truncated, false);
    assert.equal(result.fallback, false);
  });

  it('keeps the truncated body plus footer within the limit', () => {
    const maxChars = 500;
    const body = 'x'.repeat(5000);

    const result = prepareReleaseNotes({ ...context, body, maxChars });

    assert.equal(result.truncated, true);
    assert.ok(Array.from(result.body).length <= maxChars);
    assert.ok(
      result.body.endsWith(
        'https://github.com/QwenLM/qwen-code/compare/v0.21.1...v0.21.2',
      ),
    );
  });

  // The whole point of the cap is that the release still publishes, so the
  // default must leave room for the footer under GitHub's 125000 limit.
  it('stays under the API limit at the default cap', () => {
    const result = prepareReleaseNotes({
      ...context,
      body: 'x'.repeat(MAX_BODY_CHARS * 2),
    });

    assert.ok(Array.from(result.body).length <= MAX_BODY_CHARS);
    assert.ok(MAX_BODY_CHARS < 125000);
  });

  it('omits the compare link when there is no previous tag', () => {
    const result = prepareReleaseNotes({
      ...context,
      previousTag: '',
      body: 'x'.repeat(5000),
      maxChars: 500,
    });

    assert.ok(result.body.endsWith('_Release notes were truncated._'));
    assert.ok(!result.body.includes('compare'));
  });

  it('never splits a multi-byte character', () => {
    // Cut lands inside the emoji run: a code-unit slice would leave a lone
    // surrogate and an invalid body.
    const maxChars = 200;
    const body = `${'a'.repeat(50)}${'😀'.repeat(200)}`;

    const result = prepareReleaseNotes({ ...context, body, maxChars });

    assert.equal(
      Buffer.from(result.body, 'utf8').toString('utf8'),
      result.body,
    );
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.body));
  });

  it('falls back to a minimal body when the footer alone exceeds the cap', () => {
    const result = prepareReleaseNotes({
      ...context,
      body: 'x'.repeat(100),
      maxChars: 10,
    });

    assert.equal(result.body, 'Release v0.21.2');
    assert.equal(result.truncated, true);
    assert.equal(result.fallback, true);
  });

  it('falls back to a minimal body when nothing was generated', () => {
    for (const body of ['', '   \n  ']) {
      const result = prepareReleaseNotes({ ...context, body });

      assert.equal(result.body, 'Release v0.21.2');
      assert.equal(result.fallback, true);
    }
  });

  it('requires a tag', () => {
    assert.throws(
      () => prepareReleaseNotes({ body: 'notes', tag: '' }),
      /requires a tag/,
    );
  });
});

describe('release notes body preparation (cli)', () => {
  it('rewrites the notes file in place and warns on truncation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-release-notes-'));
    try {
      const file = join(dir, 'release-notes.md');
      writeFileSync(file, 'y'.repeat(5000));

      const run = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--file',
          file,
          '--tag',
          'v0.21.2',
          '--previous-tag',
          'v0.21.1',
          '--repo',
          'QwenLM/qwen-code',
          '--max-chars',
          '500',
        ],
        { encoding: 'utf8' },
      );

      assert.equal(run.status, 0);
      assert.match(run.stdout, /::warning::Release notes exceeded 500/);
      const written = readFileSync(file, 'utf8');
      assert.ok(Array.from(written.trimEnd()).length <= 500);
      assert.ok(written.includes('_Release notes were truncated._'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a minimal body when generate-notes produced no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-release-notes-'));
    try {
      const file = join(dir, 'missing.md');

      const run = spawnSync(
        process.execPath,
        [SCRIPT, '--file', file, '--tag', 'v0.21.2'],
        { encoding: 'utf8' },
      );

      assert.equal(run.status, 0);
      assert.match(run.stdout, /::warning::No release notes were generated/);
      assert.equal(readFileSync(file, 'utf8'), 'Release v0.21.2\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown options', () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, '--file', 'notes.md', '--tag', 'v1.0.0', '--nope', '1'],
      { encoding: 'utf8' },
    );

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Unknown option: --nope/);
  });
});
