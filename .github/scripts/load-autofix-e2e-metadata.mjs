#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      fail('Invalid arguments');
    options[key.slice(2)] = value;
  }
  return options;
}

function ghJson(endpoint) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

function ghJsonPages(endpoint) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint, '--paginate', '--slurp'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

export function validateMetadata(metadata, { issue, repository }) {
  if (metadata?.schemaVersion !== 1) fail('Unsupported E2E metadata schema');
  if (metadata?.kind !== 'main-e2e-failure') fail('Unexpected metadata kind');
  if (metadata?.repository !== repository) fail('Metadata repository mismatch');
  if (metadata?.issue !== issue) fail('Metadata issue mismatch');
  if (metadata?.workflow !== 'E2E Tests') fail('Unexpected source workflow');
  if (!Number.isInteger(metadata?.source?.runId) || metadata.source.runId <= 0)
    fail('Invalid source run ID');
  if (
    !Number.isInteger(metadata?.source?.runAttempt) ||
    metadata.source.runAttempt <= 0
  )
    fail('Invalid source run attempt');
  if (!/^[0-9a-f]{40}$/.test(metadata?.source?.headSha ?? ''))
    fail('Invalid source head SHA');
  if (metadata?.source?.headBranch !== 'main')
    fail('Source branch is not main');
  if (metadata?.source?.event !== 'push') fail('Source event is not push');
  if (metadata?.source?.conclusion !== 'failure')
    fail('Source conclusion is not failure');
  return metadata;
}

export function validateProducerRun(run) {
  if (run?.path !== '.github/workflows/main-ci-failure-issue.yml')
    fail('Metadata artifact was produced by an unexpected workflow');
  if (run?.event !== 'workflow_run') fail('Unexpected metadata producer event');
}

export function validateSourceRun(run, metadata) {
  if (run?.name !== 'E2E Tests') fail('Source run workflow mismatch');
  if (run?.run_attempt !== metadata.source.runAttempt)
    fail('Source run attempt mismatch');
  if (run?.event !== 'push') fail('Source run event mismatch');
  if (run?.head_branch !== 'main') fail('Source run branch mismatch');
  if (run?.conclusion !== 'failure') fail('Source run conclusion mismatch');
  if (run?.head_sha !== metadata.source.headSha)
    fail('Source run SHA mismatch');
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`Invalid ${label}`);
  return number;
}

export function parseArtifactName(name, issue) {
  const match = new RegExp(
    `^autofix-e2e-failure-${issue}-([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)$`,
  ).exec(name ?? '');
  if (!match) fail('Invalid targeted E2E artifact name');
  return {
    sourceRunId: positiveInteger(match[1], 'artifact source run ID'),
    sourceRunAttempt: positiveInteger(match[2], 'artifact source run attempt'),
    producerRunId: positiveInteger(match[3], 'artifact producer run ID'),
    producerRunAttempt: positiveInteger(
      match[4],
      'artifact producer run attempt',
    ),
  };
}

function readArtifactMetadata({ artifact, issue, repository, directory }) {
  const artifactId = positiveInteger(artifact.id, 'artifact ID');
  const archive = join(directory, `artifact-${artifactId}.zip`);
  const zip = execFileSync(
    'gh',
    ['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
    { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
  );
  writeFileSync(archive, zip);
  const entries = execFileSync('unzip', ['-Z1', archive], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  if (entries.length !== 1 || entries[0] !== 'metadata.json')
    fail('Targeted E2E artifact must contain only metadata.json');
  const metadataText = execFileSync('unzip', ['-p', archive, 'metadata.json'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return validateMetadata(JSON.parse(metadataText), { issue, repository });
}

export function loadMetadata({ issue, repository, output }) {
  const artifactPrefix = `autofix-e2e-failure-${issue}-`;
  const pages = ghJsonPages(
    `repos/${repository}/actions/artifacts?per_page=100`,
  );
  const artifacts = pages
    .flatMap((page) => page.artifacts ?? [])
    .filter(
      (artifact) =>
        artifact.name?.startsWith(artifactPrefix) && !artifact.expired,
    );
  if (!artifacts.length) fail(`No live artifact with prefix ${artifactPrefix}`);

  const directory = mkdtempSync(join(tmpdir(), 'autofix-e2e-metadata-'));
  try {
    const trusted = [];
    for (const artifact of artifacts) {
      let producerRunId;
      let producerRun;
      try {
        producerRunId = positiveInteger(
          artifact.workflow_run?.id,
          'artifact producer run ID',
        );
        producerRun = ghJson(
          `repos/${repository}/actions/runs/${producerRunId}`,
        );
        validateProducerRun(producerRun);
      } catch (error) {
        process.stderr.write(`Skipping artifact ${artifact.id}: ${error}\n`);
        continue;
      }
      const name = parseArtifactName(artifact.name, issue);
      if (producerRunId !== name.producerRunId)
        fail('Artifact producer run ID mismatch');
      const producerAttempt = ghJson(
        `repos/${repository}/actions/runs/${producerRunId}/attempts/${name.producerRunAttempt}`,
      );
      validateProducerRun(producerAttempt);
      const metadata = readArtifactMetadata({
        artifact,
        issue,
        repository,
        directory,
      });
      if (
        metadata.source.runId !== name.sourceRunId ||
        metadata.source.runAttempt !== name.sourceRunAttempt
      ) {
        fail('Artifact name does not match source metadata');
      }
      const sourceRun = ghJson(
        `repos/${repository}/actions/runs/${metadata.source.runId}/attempts/${metadata.source.runAttempt}`,
      );
      validateSourceRun(sourceRun, metadata);
      trusted.push({ metadata, name, artifactId: artifact.id });
    }
    trusted.sort(
      (left, right) =>
        right.metadata.source.runId - left.metadata.source.runId ||
        right.metadata.source.runAttempt - left.metadata.source.runAttempt ||
        right.name.producerRunId - left.name.producerRunId ||
        right.name.producerRunAttempt - left.name.producerRunAttempt ||
        right.artifactId - left.artifactId,
    );
    if (!trusted.length)
      fail(`No trusted artifact with prefix ${artifactPrefix}`);
    const metadata = trusted[0].metadata;
    writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const issue = Number(options.issue);
  if (!Number.isInteger(issue) || issue <= 0) fail('Invalid issue number');
  if (!options.repository || !options.output)
    fail('Missing required arguments');
  loadMetadata({
    issue,
    repository: options.repository,
    output: options.output,
  });
  process.stdout.write(
    `Loaded trusted targeted E2E metadata for issue #${issue}.\n`,
  );
}
