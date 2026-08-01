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

interface RunDefaults {
  shell?: unknown;
  'working-directory'?: unknown;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  jobs?: Record<string, WorkflowJob>;
}

/** Which `env:`/`defaults:` level a resolved value came from. */
export type EnvScope = 'workflow' | 'job' | 'step';

export interface ExtractedStep {
  workflow: string;
  job: string;
  /** The step's `name:` (or `id:`), plus its index within the job. */
  step: string;
  index: number;
  shell: string;
  workingDirectory?: string;
  /**
   * The EFFECTIVE `env:` the runner would hand the step — workflow, job and
   * step levels merged, nearest wins — values verbatim (they may hold
   * `${{ … }}`). Step-level only would be a lie: a step whose behaviour turns
   * on a job-level `NODE_ENV` is exactly the by-hand transcription error this
   * command exists to remove.
   */
  env: Record<string, string>;
  /** Which level each effective `env:` key came from. */
  envSources: Record<string, EnvScope>;
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

/**
 * `text` rendered as comment lines — EVERY line, not just the first. A YAML
 * block scalar (`SETTINGS_JSON: |`) reaches here as a multi-line string, and a
 * continuation line that escaped the `#` would sit in command position: under
 * the `set -e` this header emits, the extracted step then dies in its own
 * preamble, before its `run:` body ever runs.
 */
export function commentLines(firstPrefix: string, text: string): string[] {
  const [first = '', ...rest] = text.split('\n');
  return [`${firstPrefix}${first}`, ...rest.map((line) => `#   ${line}`)];
}

/** The nearest level that set a scalar — step, then job, then workflow. */
function nearestString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string');
}

/** `defaults.run` of a workflow or job, tolerating any shape the YAML holds. */
function runDefaultsOf(container: unknown): RunDefaults {
  const defaults = (container as { defaults?: unknown } | undefined)?.defaults;
  const run =
    defaults && typeof defaults === 'object'
      ? (defaults as { run?: unknown }).run
      : undefined;
  return run && typeof run === 'object' ? (run as RunDefaults) : {};
}

/**
 * Merge one level's `env:` over what the outer levels set. Called
 * workflow → job → step, so the nearest level wins, exactly as the runner
 * resolves it.
 */
function mergeEnv(
  container: unknown,
  scope: EnvScope,
  env: Record<string, string>,
  sources: Record<string, EnvScope>,
): void {
  const raw = (container as { env?: unknown } | undefined)?.env;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    env[k] = String(v);
    sources[k] = scope;
  }
}

export interface ExtractStepArgs {
  workflow: string;
  job: string;
  step: string;
  out: string;
}

export function runExtractStep(args: ExtractStepArgs): ExtractedStep {
  const wfPath = resolve(args.workflow);
  let doc: WorkflowDoc;
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

  // `env:`, `shell:` and `working-directory:` are all THREE-level settings on
  // GitHub — workflow, job, step, nearest wins — and only the step level is
  // visible in the step's own text. Reading step-level alone reproduces by
  // machine the transcription error this command exists to remove: the script
  // runs with an empty `$NODE_ENV` a job-level `env:` would have set, in the
  // wrong directory, and nothing says so.
  const workflowDefaults = runDefaultsOf(doc);
  const jobDefaults = runDefaultsOf(job);
  const env: Record<string, string> = {};
  const envSources: Record<string, EnvScope> = {};
  mergeEnv(doc, 'workflow', env, envSources);
  mergeEnv(job, 'job', env, envSources);
  mergeEnv(step, 'step', env, envSources);

  // GitHub's default for run steps on Linux runners is `bash -e`; a `shell:`
  // at any level overrides. Recorded either way, because the caller must
  // invoke the script with the same shell the runner would.
  const shell =
    nearestString(step.shell, jobDefaults.shell, workflowDefaults.shell) ??
    'bash';
  const workingDirectory = nearestString(
    step['working-directory'],
    jobDefaults['working-directory'],
    workflowDefaults['working-directory'],
  );

  const script = step.run;
  const stepLabel = String(step.name ?? step.id ?? index);
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  // Verbatim body under a header that names its provenance. The env block is
  // emitted as COMMENTS, not exports: its values may hold `${{ … }}` the
  // caller must stub, and a half-substituted export would run where a loud
  // unbound variable should. Each entry carries the level it came from, so a
  // reader of the script alone can tell an inherited value from the step's own.
  const header = [
    `#!/usr/bin/env ${shell === 'bash' ? 'bash' : shell}`,
    ...commentLines(
      '# extracted verbatim from ',
      `${args.workflow} — job \`${args.job}\`, step \`${stepLabel}\``,
    ),
    ...(shell === 'bash' ? ['set -e'] : []),
    ...Object.entries(env).flatMap(([k, v]) =>
      commentLines(`# env [${envSources[k]}] ${k}=`, v),
    ),
    '',
  ].join('\n');
  writeFileSync(outPath, header + script + (script.endsWith('\n') ? '' : '\n'));
  chmodSync(outPath, 0o755);

  return {
    workflow: args.workflow,
    job: args.job,
    step: stepLabel,
    index,
    shell,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    env,
    envSources,
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
    const inherited = Object.values(meta.envSources).filter(
      (scope) => scope !== 'step',
    ).length;
    writeStderrLine(
      `extract-step: wrote ${meta.scriptPath} (${meta.expressions.length} \${{ }} site(s) to stub, ` +
        `${Object.keys(meta.env).length} env var(s), ${inherited} inherited from job/workflow, ` +
        `invokes: ${meta.invokes.join(', ') || '(none detected)'})`,
    );
  },
};
