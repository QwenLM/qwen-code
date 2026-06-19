import {
  desktopReleasePackageSources,
  normalizeReleaseVersion,
  readPackageVersion,
  writePackageVersion,
} from './desktop-release-version.ts';

interface ParsedArgs {
  dryRun: boolean;
  version?: string;
}

interface VersionChange {
  currentVersion: string;
  path: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      if (!next) throw new Error(`${arg} requires a value.`);
      if (args.version) throw new Error('Only one release version is allowed.');
      args.version = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (args.version) {
      throw new Error('Only one release version is allowed.');
    }
    args.version = arg;
  }

  return args;
}

function printUsage(): void {
  console.error(
    [
      'Usage: bun run bump-desktop-version <version>',
      '       bun run bump-desktop-version --dry-run <version>',
      '',
      'Examples:',
      '  bun run bump-desktop-version 0.0.2',
      '  bun run bump-desktop-version v0.0.2',
    ].join('\n'),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    printUsage();
    throw new Error('Release version is required.');
  }

  const { tag, version } = normalizeReleaseVersion(args.version);
  const changes: VersionChange[] = desktopReleasePackageSources.map(
    (source) => ({
      currentVersion: readPackageVersion(source.path),
      path: source.path,
    }),
  );
  const pendingChanges = changes.filter(
    (change) => change.currentVersion !== version,
  );

  if (args.dryRun) {
    console.log(`Desktop version dry run: ${version} (${tag})`);
    for (const change of changes) {
      const suffix =
        change.currentVersion === version
          ? 'already set'
          : `${change.currentVersion} -> ${version}`;
      console.log(`  - ${change.path}: ${suffix}`);
    }
    console.log('No files were changed.');
    return;
  }

  for (const change of pendingChanges) {
    writePackageVersion(change.path, version);
  }

  if (pendingChanges.length === 0) {
    console.log(`Desktop version already set to ${version} (${tag})`);
    return;
  }

  console.log(`Updated desktop version to ${version} (${tag})`);
  for (const change of pendingChanges) {
    console.log(`  - ${change.path}: ${change.currentVersion} -> ${version}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
