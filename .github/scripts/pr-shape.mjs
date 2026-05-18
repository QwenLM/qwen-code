#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { parseArgs, readJson, requireArg, run, writeJson } from './lib/cli.mjs';
import { buildPrShape } from './lib/pr-shape-core.mjs';

async function main() {
  const args = parseArgs();
  const repo = requireArg(args, 'repo');
  const prNumber = requireArg(args, 'pr');
  const out = requireArg(args, 'out');

  const pr =
    (await readJson(args['pr-json'], undefined)) ??
    JSON.parse(
      await run('gh', [
        'pr',
        'view',
        prNumber,
        '--repo',
        repo,
        '--json',
        'additions,deletions,changedFiles,title,body,baseRefName,headRefName,url',
      ]),
    );

  const diffText = args['diff-file']
    ? await readFile(args['diff-file'], 'utf8')
    : await run('gh', ['pr', 'diff', prNumber, '--repo', repo, '--patch']);

  const shape = buildPrShape({
    diffText,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
  });

  await writeJson(out, shape);
  console.log(`Wrote PR shape to ${out}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
