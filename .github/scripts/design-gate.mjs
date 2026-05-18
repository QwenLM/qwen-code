#!/usr/bin/env node

import {
  parseArgs,
  readJson,
  requireArg,
  run,
  writeJson,
  writeText,
} from './lib/cli.mjs';
import { loadAnchors } from './lib/anchors.mjs';
import {
  evaluateDesignGate,
  formatProcessComment,
  formatPromptAppend,
} from './lib/design-gate-core.mjs';
import { runQwenJson } from './lib/llm.mjs';

function buildLlmPrompt({ pr, shape, history, anchors }) {
  return [
    'You are Qwen Code Design Gate. Return JSON only.',
    'Schema: {"findings":[{"gate":"product_direction|scope|architecture|claude_code","severity":"advisory|blocking","message":"...","citations":["..."]}]}',
    'Blocking findings require citations. Claude Code comparison findings must be advisory.',
    '',
    'PR:',
    JSON.stringify({ title: pr.title, body: pr.body }, null, 2),
    '',
    'PR shape:',
    JSON.stringify(shape, null, 2),
    '',
    'History scan:',
    JSON.stringify(history.findings ?? [], null, 2),
    '',
    'Anchors:',
    JSON.stringify(anchors.loaded, null, 2),
  ].join('\n');
}

async function maybeRunLlm({ pr, shape, history, anchors }) {
  if (process.env.QWEN_DESIGN_GATE_LLM !== 'true') {
    return { findings: [] };
  }

  try {
    const result = await runQwenJson({
      prompt: buildLlmPrompt({ pr, shape, history, anchors }),
    });
    return result.json && Array.isArray(result.json.findings)
      ? result.json
      : { findings: [] };
  } catch (error) {
    return {
      findings: [
        {
          gate: 'product_direction',
          severity: 'advisory',
          message: `Design Gate LLM check skipped: ${error.message}`,
          citations: [],
        },
      ],
    };
  }
}

async function main() {
  const args = parseArgs();
  const repo = requireArg(args, 'repo');
  const prNumber = requireArg(args, 'pr');
  const shape = await readJson(requireArg(args, 'shape'));
  const history = await readJson(requireArg(args, 'history'), { findings: [] });
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
        'title,body,url,baseRefName,headRefName',
      ]),
    );

  const anchors = await loadAnchors({
    rootDir: args.root ?? process.cwd(),
    changedFiles: shape.changed_files,
  });
  const llm = await maybeRunLlm({ pr, shape, history, anchors });
  const result = evaluateDesignGate({ pr, shape, history, anchors, llm });

  await writeJson(out, result);
  if (args['process-comment-out']) {
    await writeText(args['process-comment-out'], formatProcessComment(result));
  }
  if (args['prompt-append-out']) {
    await writeText(args['prompt-append-out'], formatPromptAppend(result));
  }

  console.log(`Design Gate status: ${result.status}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
