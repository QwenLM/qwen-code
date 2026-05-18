#!/usr/bin/env node

import { parseArgs, readJson, requireArg, run, writeJson } from './lib/cli.mjs';
import { scanHistory } from './lib/gh-search.mjs';

async function main() {
  const args = parseArgs();
  const repo = requireArg(args, 'repo');
  const prNumber = requireArg(args, 'pr');
  const shape = await readJson(requireArg(args, 'shape'));
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
        'title,body,url',
      ]),
    );

  const history = await scanHistory({
    repo,
    pr,
    shape,
    limit: Number(args.limit ?? 20),
  });

  await writeJson(out, history);
  console.log(`Wrote history scan to ${out}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
