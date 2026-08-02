import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadMetadata,
  parseArtifactName,
  validateMetadata,
  validateProducerRun,
  validateSourceRun,
} from './load-autofix-e2e-metadata.mjs';

const metadata = {
  schemaVersion: 1,
  kind: 'main-e2e-failure',
  repository: 'QwenLM/qwen-code',
  issue: 123,
  workflow: 'E2E Tests',
  source: {
    runId: 456,
    runAttempt: 2,
    headSha: 'a'.repeat(40),
    headBranch: 'main',
    event: 'push',
    conclusion: 'failure',
  },
};

test('validates issue-bound targeted E2E metadata', () => {
  assert.equal(
    validateMetadata(metadata, {
      issue: 123,
      repository: 'QwenLM/qwen-code',
    }),
    metadata,
  );
  assert.throws(
    () =>
      validateMetadata(metadata, {
        issue: 124,
        repository: 'QwenLM/qwen-code',
      }),
    /Metadata issue mismatch/,
  );
  assert.throws(
    () =>
      validateMetadata(metadata, {
        issue: 123,
        repository: 'attacker/fork',
      }),
    /Metadata repository mismatch/,
  );
});

test('binds immutable artifact names to source and producer runs', () => {
  assert.deepEqual(
    parseArtifactName('autofix-e2e-failure-123-456-2-700-1', 123),
    {
      sourceRunId: 456,
      sourceRunAttempt: 2,
      producerRunId: 700,
      producerRunAttempt: 1,
    },
  );
  assert.throws(
    () => parseArtifactName('autofix-e2e-failure-123', 123),
    /Invalid targeted E2E artifact name/,
  );
  assert.throws(
    () => parseArtifactName('autofix-e2e-failure-124-456-2-700', 123),
    /Invalid targeted E2E artifact name/,
  );
});

test('requires the trusted producer workflow and event', () => {
  validateProducerRun({
    path: '.github/workflows/main-ci-failure-issue.yml',
    event: 'workflow_run',
  });
  assert.throws(
    () =>
      validateProducerRun({
        path: '.github/workflows/attacker.yml',
        event: 'workflow_run',
      }),
    /unexpected workflow/,
  );
  assert.throws(
    () =>
      validateProducerRun({
        path: '.github/workflows/main-ci-failure-issue.yml',
        event: 'pull_request',
      }),
    /producer event/,
  );
});

test('revalidates the referenced source run against immutable fields', () => {
  const run = {
    name: 'E2E Tests',
    run_attempt: 2,
    event: 'push',
    head_branch: 'main',
    conclusion: 'failure',
    head_sha: metadata.source.headSha,
  };
  validateSourceRun(run, metadata);
  assert.throws(
    () => validateSourceRun({ ...run, run_attempt: 3 }, metadata),
    /attempt mismatch/,
  );
  assert.throws(
    () => validateSourceRun({ ...run, conclusion: 'success' }, metadata),
    /conclusion mismatch/,
  );
  assert.throws(
    () => validateSourceRun({ ...run, head_sha: 'b'.repeat(40) }, metadata),
    /SHA mismatch/,
  );
});

test('chooses the latest trusted source recurrence, not the newest artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'load-e2e-order-test-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'metadata.json');
  const calls = join(directory, 'calls.log');
  const originalPath = process.env['PATH'];
  const olderSource = {
    ...metadata,
    source: { ...metadata.source, runId: 456 },
  };
  const newerSource = {
    ...metadata,
    source: { ...metadata.source, runId: 457, runAttempt: 1 },
  };
  const olderEncoded = Buffer.from(JSON.stringify(olderSource)).toString(
    'base64',
  );
  const newerEncoded = Buffer.from(JSON.stringify(newerSource)).toString(
    'base64',
  );
  try {
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
        'case "$*" in',
        '  *"actions/artifacts?per_page=100"*) printf \'%s\' \'[{"artifacts":[{"id":30,"name":"autofix-e2e-failure-123-malformed","expired":false,"workflow_run":{"id":730}},{"id":20,"name":"autofix-e2e-failure-123-456-2-720-1","expired":false,"workflow_run":{"id":720}},{"id":10,"name":"autofix-e2e-failure-123-457-1-710-1","expired":false,"workflow_run":{"id":710}}]}]\';;',
        '  *"actions/runs/730"*) printf \'%s\' \'{"path":".github/workflows/attacker.yml","event":"workflow_run"}\';;',
        '  *"actions/runs/720"*|*"actions/runs/710"*) printf \'%s\' \'{"path":".github/workflows/main-ci-failure-issue.yml","event":"workflow_run"}\';;',
        '  *"actions/artifacts/20/zip"*) printf \'older-zip\';;',
        '  *"actions/artifacts/10/zip"*) printf \'newer-zip\';;',
        '  *"actions/runs/456"*) printf \'%s\' \'{"name":"E2E Tests","run_attempt":2,"event":"push","head_branch":"main","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\';;',
        '  *"actions/runs/457"*) printf \'%s\' \'{"name":"E2E Tests","run_attempt":1,"event":"push","head_branch":"main","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\';;',
        '  *) exit 1;;',
        'esac',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(bin, 'unzip'),
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "-Z1" ]]; then',
        "  printf 'metadata.json\\n'",
        'elif [[ "$2" == *"artifact-20.zip" ]]; then',
        `  printf '%s' '${olderEncoded}' | base64 --decode`,
        'else',
        `  printf '%s' '${newerEncoded}' | base64 --decode`,
        'fi',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'unzip'), 0o755);
    process.env['PATH'] = `${bin}:${originalPath}`;

    assert.deepEqual(
      loadMetadata({
        issue: 123,
        repository: 'QwenLM/qwen-code',
        output,
      }),
      newerSource,
    );
    const invocationLog = readFileSync(calls, 'utf8');
    assert.doesNotMatch(invocationLog, /actions\/artifacts\/30\/zip/);
    assert.match(invocationLog, /actions\/artifacts\/20\/zip/);
    assert.match(invocationLog, /actions\/artifacts\/10\/zip/);
    assert.match(invocationLog, /actions\/runs\/456\/attempts\/2/);
    assert.match(invocationLog, /actions\/runs\/457\/attempts\/1/);
  } finally {
    process.env['PATH'] = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uses immutable producer identity to break equal-source ties', () => {
  const directory = mkdtempSync(join(tmpdir(), 'load-e2e-tie-test-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'metadata.json');
  const originalPath = process.env['PATH'];
  const olderProducer = { ...metadata, producer: 'older' };
  const newerProducer = { ...metadata, producer: 'newer' };
  const olderEncoded = Buffer.from(JSON.stringify(olderProducer)).toString(
    'base64',
  );
  const newerEncoded = Buffer.from(JSON.stringify(newerProducer)).toString(
    'base64',
  );
  try {
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"actions/artifacts?per_page=100"*) printf \'%s\' \'[{"artifacts":[{"id":10,"name":"autofix-e2e-failure-123-456-2-700-1","expired":false,"workflow_run":{"id":700}},{"id":20,"name":"autofix-e2e-failure-123-456-2-701-1","expired":false,"workflow_run":{"id":701}}]}]\';;',
        '  *"actions/runs/700"*|*"actions/runs/701"*) printf \'%s\' \'{"path":".github/workflows/main-ci-failure-issue.yml","event":"workflow_run"}\';;',
        '  *"actions/artifacts/10/zip"*) printf \'older-zip\';;',
        '  *"actions/artifacts/20/zip"*) printf \'newer-zip\';;',
        '  *"actions/runs/456"*) printf \'%s\' \'{"name":"E2E Tests","run_attempt":2,"event":"push","head_branch":"main","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\';;',
        '  *) exit 1;;',
        'esac',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(bin, 'unzip'),
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "-Z1" ]]; then',
        "  printf 'metadata.json\\n'",
        'elif [[ "$2" == *"artifact-10.zip" ]]; then',
        `  printf '%s' '${olderEncoded}' | base64 --decode`,
        'else',
        `  printf '%s' '${newerEncoded}' | base64 --decode`,
        'fi',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'unzip'), 0o755);
    process.env['PATH'] = `${bin}:${originalPath}`;

    assert.deepEqual(
      loadMetadata({
        issue: 123,
        repository: 'QwenLM/qwen-code',
        output,
      }),
      newerProducer,
    );
  } finally {
    process.env['PATH'] = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed artifact and producer run identifiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'load-e2e-id-test-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'metadata.json');
  const originalPath = process.env['PATH'];
  try {
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"actions/artifacts?per_page=100"*) printf \'%s\' \'[{"artifacts":[{"id":"../../escape","name":"autofix-e2e-failure-123-456-2-700-1","expired":false,"workflow_run":{"id":700}}]}]\';;',
        '  *"actions/runs/700"*) printf \'%s\' \'{"path":".github/workflows/main-ci-failure-issue.yml","event":"workflow_run"}\';;',
        '  *) exit 1;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    process.env['PATH'] = `${bin}:${originalPath}`;
    assert.throws(
      () =>
        loadMetadata({
          issue: 123,
          repository: 'QwenLM/qwen-code',
          output,
        }),
      /Invalid artifact ID/,
    );
  } finally {
    process.env['PATH'] = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loads only metadata whose artifact producer and source run validate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'load-e2e-metadata-test-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'metadata.json');
  const calls = join(directory, 'calls.log');
  const originalPath = process.env['PATH'];
  const encodedMetadata = Buffer.from(JSON.stringify(metadata)).toString(
    'base64',
  );
  try {
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
        'case "$*" in',
        '  *"actions/artifacts?per_page=100"*) printf \'%s\' \'[{"artifacts":[{"id":9,"name":"autofix-e2e-failure-123-456-2-700-1","expired":false,"created_at":"2026-07-31T00:00:00Z","workflow_run":{"id":700}}]}]\';;',
        '  *"actions/runs/700"*) printf \'%s\' \'{"path":".github/workflows/main-ci-failure-issue.yml","event":"workflow_run"}\';;',
        '  *"actions/artifacts/9/zip"*) printf \'zip-bytes\';;',
        '  *"actions/runs/456"*) printf \'%s\' \'{"name":"E2E Tests","run_attempt":2,"event":"push","head_branch":"main","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\';;',
        '  *) exit 1;;',
        'esac',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(bin, 'unzip'),
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "-Z1" ]]; then',
        "  printf 'metadata.json\\n'",
        'else',
        `  printf '%s' '${encodedMetadata}' | base64 --decode`,
        'fi',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'unzip'), 0o755);
    process.env['PATH'] = `${bin}:${originalPath}`;

    const loaded = loadMetadata({
      issue: 123,
      repository: 'QwenLM/qwen-code',
      output,
    });
    assert.deepEqual(loaded, metadata);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), metadata);
    const invocationLog = readFileSync(calls, 'utf8');
    assert.match(invocationLog, /actions\/artifacts\/9\/zip/);
    assert.match(invocationLog, /actions\/runs\/456/);
  } finally {
    process.env['PATH'] = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects an artifact whose real producer run differs from its name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'load-e2e-mismatch-test-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'metadata.json');
  const originalPath = process.env['PATH'];
  try {
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"actions/artifacts?per_page=100"*) printf \'%s\' \'[{"artifacts":[{"id":10,"name":"autofix-e2e-failure-123-456-2-700-1","expired":false,"workflow_run":{"id":701}}]}]\';;',
        '  *"actions/runs/701"*) printf \'%s\' \'{"path":".github/workflows/main-ci-failure-issue.yml","event":"workflow_run"}\';;',
        '  *) exit 1;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    process.env['PATH'] = `${bin}:${originalPath}`;
    assert.throws(
      () =>
        loadMetadata({
          issue: 123,
          repository: 'QwenLM/qwen-code',
          output,
        }),
      /Artifact producer run ID mismatch/,
    );
  } finally {
    process.env['PATH'] = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
