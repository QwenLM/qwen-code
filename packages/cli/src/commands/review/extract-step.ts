/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review extract-step`: lift one workflow step's `run:` script out of a
// workflow file, verbatim, into an executable — so a claim about what a
// workflow DOES can be settled by running the real step instead of reading it.
//
// The strongest workflow verification observed in this repo's own review
// history did exactly this by hand: extract the composer step from both the
// merge base and the PR head, stub `gh`, feed both the same real report, and
// diff what each would have posted. The extraction half of that is entirely
// mechanical — find the job, find the step, take its `run:` string — and doing
// it by hand is where it goes wrong quietly: a hand-copied script silently
// drops the `env:` block that changes its behaviour, or picks the same-named
// step from the wrong job. So the mechanical half lives here.
//
// What this command deliberately does NOT do:
//
//   - **Evaluate `${{ … }}` expressions.** They are GitHub-side interpolation,
//     and any value this command inserted would be an invention. The script is
//     emitted verbatim; every expression site is LISTED in the metadata so the
//     caller knows exactly what to stub — with env vars, a wrapper, or edits.
//   - **Stub anything.** Which commands to fake (`gh`, `curl`, a deploy CLI)
//     depends entirely on the claim under test. Stubbing is the verifier's
//     half; the metadata names the commands the script invokes as a starting
//     point.
//   - **Run anything.** The PR's workflow text is untrusted input; this
//     command only ever reads it and writes a file. Whether and where to run
//     the extraction is the caller's decision — the same trust boundary as
//     build-test running the PR's build.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

interface WorkflowStep {
  name?: unknown;
  id?: unknown;
  run?: unknown;
  shell?: unknown;
  'working-directory'?: unknown;
  env?: unknown;
}

export interface ExtractedStep {
  workflow: string;
  job: string;
  /** The step's `name:` (or `id:`), plus its index within the job. */
  step: string;
  index: number;
  shell: string;
  workingDirectory?: string;
  /** The step-level `env:` keys, values verbatim (they may hold `${{ … }}`). */
  env: Record<string, string>;
  /** Every distinct `${{ … }}` expression in the script and env — the stub list. */
  expressions: string[];
  /** Top-level commands the script invokes — a starting point for stubbing. */
  invokes: string[];
  /** Where the executable was written. */
  scriptPath: string;
}

/** Every distinct `${{ … }}` site, in order of first appearance. */
export function expressionsOf(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\$\{\{[^}]*\}\}/g)) seen.add(m[0].trim());
  }
  return [...seen];
}

/**
 * Command words a stub would have to cover: the first word of each pipeline
 * segment, minus shell keywords and paths. Heuristic on purpose — it is a
 * starting point handed to a reviewer, not a parse; the script itself is the
 * authority and ships verbatim beside it.
 */
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'return',
  'exit',
  'local',
  'export',
  'set',
  'echo',
  'printf',
  'read',
  'shift',
  'trap',
  'true',
  'false',
  'cd',
  'test',
]);

export function invokedCommandsOf(script: string): string[] {
  const seen = new Set<string>();
  const scanSegment = (seg: string) => {
    // Descend into command substitutions first — `body="$(sanitize < f)"` is
    // an assignment whose real invocation lives inside the `$()`.
    for (const m of seg.matchAll(/\$\(([^()]*)\)/g)) scanSegment(m[1]);
    const words = seg
      .trim()
      .replace(/^[\s(]+/, '')
      .split(/\s+/);
    for (const word of words) {
      // Step over leading `name=value` assignment prefixes, any case.
      if (/^[\w]+=/.test(word)) continue;
      if (/^[A-Za-z][\w.:+-]*$/.test(word) && !KEYWORDS.has(word)) {
        seen.add(word);
      }
      break; // only the command position; arguments are not invocations
    }
  };
  for (const rawLine of script.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    for (const seg of line.split(/(?:\|\||&&|\||;)/)) scanSegment(seg);
  }
  return [...seen].sort();
}

export interface ExtractStepArgs {
  workflow: string;
  job: string;
  step: string;
  out: string;
}

export function runExtractStep(args: ExtractStepArgs): ExtractedStep {
  const wfPath = resolve(args.workflow);
  let doc: { jobs?: Record<string, { steps?: WorkflowStep[] }> };
  try {
    doc = parse(readFileSync(wfPath, 'utf8')) as typeof doc;
  } catch (err) {
    throw new Error(
      `extract-step: cannot parse ${args.workflow}: ${(err as Error).message}`,
    );
  }
  const job = doc?.jobs?.[args.job];
  if (!job) {
    throw new Error(
      `extract-step: no job \`${args.job}\` in ${args.workflow} — jobs: ${Object.keys(doc?.jobs ?? {}).join(', ') || '(none)'}`,
    );
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  // Match by name, id, or 0-based index — exact, never substring: two steps
  // named "Post comment" and "Post comment (retry)" must not alias.
  const index = /^\d+$/.test(args.step)
    ? Number(args.step)
    : steps.findIndex((s) => s?.name === args.step || s?.id === args.step);
  const step = steps[index];
  if (!step) {
    const named = steps
      .map((s, i) => `${i}: ${String(s?.name ?? s?.id ?? '(unnamed)')}`)
      .join('; ');
    throw new Error(
      `extract-step: no step \`${args.step}\` in job \`${args.job}\` — steps: ${named || '(none)'}`,
    );
  }
  if (typeof step.run !== 'string' || !step.run.trim()) {
    throw new Error(
      `extract-step: step \`${args.step}\` has no \`run:\` script (a \`uses:\` action cannot be extracted)`,
    );
  }

  // GitHub's default for run steps on Linux runners is `bash -e`; an explicit
  // `shell:` overrides. Recorded either way, because the caller must invoke
  // the script with the same shell the runner would.
  const shell = typeof step.shell === 'string' ? step.shell : 'bash';
  const env: Record<string, string> = {};
  if (step.env && typeof step.env === 'object') {
    for (const [k, v] of Object.entries(step.env as Record<string, unknown>)) {
      env[k] = String(v);
    }
  }

  const script = step.run;
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  // Verbatim body under a header that names its provenance. The env block is
  // emitted as COMMENTS, not exports: its values may hold `${{ … }}` the
  // caller must stub, and a half-substituted export would run where a loud
  // unbound variable should.
  const header = [
    `#!/usr/bin/env ${shell === 'bash' ? 'bash' : shell}`,
    `# extracted verbatim from ${args.workflow} — job \`${args.job}\`, step \`${String(step.name ?? step.id ?? index)}\``,
    ...(shell === 'bash' ? ['set -e'] : []),
    ...Object.entries(env).map(([k, v]) => `# env ${k}=${v}`),
    '',
  ].join('\n');
  writeFileSync(outPath, header + script + (script.endsWith('\n') ? '' : '\n'));
  chmodSync(outPath, 0o755);

  return {
    workflow: args.workflow,
    job: args.job,
    step: String(step.name ?? step.id ?? index),
    index,
    shell,
    ...(typeof step['working-directory'] === 'string'
      ? { workingDirectory: step['working-directory'] }
      : {}),
    env,
    expressions: expressionsOf(script, ...Object.values(env)),
    invokes: invokedCommandsOf(script),
    scriptPath: outPath,
  };
}

export const extractStepCommand: CommandModule = {
  command: 'extract-step',
  describe:
    "Extract one workflow step's run: script, verbatim, into an executable — with its env and ${{ }} stub list as metadata",
  builder: (yargs) =>
    yargs
      .option('workflow', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the workflow YAML (in the tree being reviewed)',
      })
      .option('job', { type: 'string', demandOption: true, describe: 'Job id' })
      .option('step', {
        type: 'string',
        demandOption: true,
        describe: 'Step name, id, or 0-based index within the job',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the executable script',
      }),
  handler: (argv) => {
    const meta = runExtractStep(argv as unknown as ExtractStepArgs);
    writeStdoutLine(JSON.stringify(meta, null, 2));
    writeStderrLine(
      `extract-step: wrote ${meta.scriptPath} (${meta.expressions.length} \${{ }} site(s) to stub, invokes: ${meta.invokes.join(', ') || '(none detected)'})`,
    );
  },
};
