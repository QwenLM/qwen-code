import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { valid } from 'semver';

interface PackageVersionSource {
  label: string;
  path: string;
}

interface ParsedArgs {
  githubOutput?: string;
  githubSummary?: string;
  version?: string;
}

const repoRoot = join(import.meta.dir, '..');
const packageVersionSources: PackageVersionSource[] = [
  { label: 'root package', path: 'package.json' },
  { label: 'Electron app package', path: 'apps/electron/package.json' },
  { label: 'shared package', path: 'packages/shared/package.json' },
];

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    githubOutput: process.env.GITHUB_OUTPUT || undefined,
    githubSummary: process.env.GITHUB_STEP_SUMMARY || undefined,
    version: process.env.RELEASE_VERSION || undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--version' || arg === '-v') {
      if (!next) throw new Error(`${arg} requires a value.`);
      args.version = next;
      i += 1;
      continue;
    }

    if (arg === '--github-output') {
      if (!next) throw new Error(`${arg} requires a value.`);
      args.githubOutput = next;
      i += 1;
      continue;
    }

    if (arg === '--github-summary') {
      if (!next) throw new Error(`${arg} requires a value.`);
      args.githubSummary = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function normalizeReleaseVersion(input: string): {
  tag: string;
  version: string;
} {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Release version is required.');
  }

  const refPrefix = 'refs/tags/';
  const tag = raw.startsWith(refPrefix) ? raw.slice(refPrefix.length) : raw;
  const candidate = tag.startsWith('v') ? tag.slice(1) : tag;
  const version = valid(candidate);

  if (!version) {
    throw new Error(
      `Invalid release version "${input}". Use SemVer like 0.0.2 or v0.0.2.`,
    );
  }

  if (version.includes('+')) {
    throw new Error(
      `Release version "${input}" includes build metadata, which is not supported for desktop releases.`,
    );
  }

  return {
    tag: `v${version}`,
    version,
  };
}

function readPackageVersion(path: string): string {
  const absolutePath = join(repoRoot, path);
  const packageJson = JSON.parse(readFileSync(absolutePath, 'utf-8')) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error(`${path} does not define a package version.`);
  }

  return packageJson.version.trim();
}

function appendGithubOutput(
  outputPath: string | undefined,
  outputs: Record<string, string>,
): void {
  if (!outputPath) return;

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function appendGithubSummary(
  summaryPath: string | undefined,
  params: {
    mismatches: { actual: string; source: PackageVersionSource }[];
    packageVersions: { source: PackageVersionSource; version: string }[];
    tag: string;
    version: string;
  },
): void {
  if (!summaryPath) return;

  const lines = [
    '## Desktop release version',
    '',
    `Version: ${params.version}`,
    `Release tag: ${params.tag}`,
    '',
    '| Source | Version |',
    '| --- | --- |',
    ...params.packageVersions.map(
      ({ source, version }) => `| ${source.path} | ${version} |`,
    ),
  ];

  if (params.mismatches.length > 0) {
    lines.push('', 'Version mismatch detected. Update source versions first.');
  }

  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    throw new Error(
      'Release version is required. Pass --version or RELEASE_VERSION.',
    );
  }

  const { tag, version } = normalizeReleaseVersion(args.version);
  const packageVersions = packageVersionSources.map((source) => ({
    source,
    version: readPackageVersion(source.path),
  }));
  const mismatches = packageVersions
    .filter((entry) => entry.version !== version)
    .map((entry) => ({
      actual: entry.version,
      source: entry.source,
    }));

  appendGithubSummary(args.githubSummary, {
    mismatches,
    packageVersions,
    tag,
    version,
  });

  if (mismatches.length > 0) {
    const details = mismatches
      .map(({ actual, source }) => `  - ${source.path}: ${actual}`)
      .join('\n');
    throw new Error(
      [
        `Release version mismatch. Requested ${version}, but source versions differ:`,
        details,
        'Update package.json, apps/electron/package.json, and packages/shared/package.json before releasing.',
      ].join('\n'),
    );
  }

  appendGithubOutput(args.githubOutput, { tag, version });
  console.log(`Release version OK: ${version} (${tag})`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
