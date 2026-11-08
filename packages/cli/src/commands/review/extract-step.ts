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
  /**
   * Every distinct `${{ … }}` expression in anything this command carries —
   * the script, the effective env, the working directory, the shell template.
   * The stub list, and the caller reads it as complete.
   */
  expressions: string[];
  /** Top-level commands the script invokes — a starting point for stubbing. */
  invokes: string[];
  /** Where the executable was written. */
  scriptPath: string;
}

/**
 * Every distinct `${{ … }}` site, in order of first appearance. Scans forward
 * to the closing `}}` rather than matching `[^}]*`: a GitHub expression may
 * legally contain a brace — `format('refs/pull/{0}/head', …)`,
 * `fromJSON('{"a":1}')` — and a pattern that stops at the first `}` does not
 * mis-list such a site, it DROPS it. Silence is the one failure this list
 * cannot afford: the caller reads it as "these are all the values to supply",
 * so a missing entry is a value that never gets stubbed.
 */
export function expressionsOf(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    let i = t.indexOf('${{');
    while (i !== -1) {
      const end = t.indexOf('}}', i + 3);
      if (end === -1) break; // unterminated — no site to report
      // A site may not span another OPENER. Scanning forward to the next `}}`
      // is right for `format('{0}')`, but a MALFORMED site above a real one
      // has no `}}` of its own, so the scan runs past it to the genuine site's
      // close and swallows both into one blob — measured:
      // `${{ github.event.issue.title }` (one brace) above a real
      // `${{ github.event.comment.body }}` left the second one unenumerated.
      // Dropping an injection site is the one direction this list must not
      // fail in, so an interleaved opener abandons the malformed site and
      // restarts at it.
      const nextOpen = t.indexOf('${{', i + 3);
      if (nextOpen !== -1 && nextOpen < end) {
        i = nextOpen;
        continue;
      }
      seen.add(t.slice(i, end + 2).trim());
      i = t.indexOf('${{', end + 2);
    }
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
  // Builtins and keywords a stub could not intercept anyway.
  'break',
  'continue',
  'eval',
  'exec',
  'source',
  'unset',
  'wait',
  'declare',
  'readonly',
  'let',
  'command',
  'builtin',
  'type',
  'hash',
  'umask',
  'getopts',
  'alias',
  'pushd',
  'popd',
]);

/**
 * Replace every `${{ … }}` with an opaque token. A GitHub expression is not
 * shell, and it routinely contains `||` — splitting on that as if it were a
 * pipeline reports both operands as invoked commands (`matrix.arch`,
 * `github.event.inputs.version`). The token has to OCCUPY the position rather
 * than vanish from it: masking to a quoted token let the quote-stripper delete
 * it, and `${{ steps.x.outputs.cmd }} arg` then reported `arg` as the command.
 * `$EXPR` survives stripping and cannot match a command word, so an expression
 * in command position contributes nothing — honest, since what it expands to
 * is unknown here by design.
 */
function maskExpressions(line: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = line.indexOf('${{', i);
    if (start === -1) return out + line.slice(i);
    const end = line.indexOf('}}', start + 3);
    out += `${line.slice(i, start)}$EXPR`;
    if (end === -1) return out;
    i = end + 2;
  }
}

/**
 * KNOWN LIMIT, measured rather than assumed: the quote walk is FLAT, and shell
 * quoting nests — a `"` inside `$( … )` inside a `"` string opens a fresh
 * context the runner tracks and this does not. Over a long script the two
 * drift, and past roughly 300 lines of this repo's own autofix workflow the
 * drift starts reporting fragments of jq source as commands. Deliberately not
 * papered over: inserting a separator where a blanked span was removes those
 * fragments, but it also splits `a"X"b`, which is one word (`aXb`) to the
 * shell, and no test short enough to be a test can pin the difference — the
 * minimal reproducer is 296 lines. An over-report is the safe direction here
 * and the script itself ships verbatim beside the list, so the junk costs a
 * reviewer a glance; a scanner nobody can pin costs them the next bug.
 *
 * Blank out quoted spans, carrying the quote across lines. Everything inside
 * quotes is DATA, and a line-based word split that runs through a quote reads
 * it as code: `EVIDENCE_SECTION=$'### Evidence images'` steps over the
 * `name=` prefix and then reports `Evidence` as an invoked command — the
 * single largest source of junk measured on this repo's workflows. Command
 * substitutions are read before this runs, so `"$(sanitize …)"` still counts.
 */
function stripQuoted(
  line: string,
  open: '"' | "'" | null,
): { live: string; open: '"' | "'" | null; heredocs: Heredoc[] } {
  let live = '';
  let quote = open;
  // `cat <<A <<B` opens two, and their bodies follow in order. Tracking only
  // the first leaves the second body — and its terminator — read as commands.
  const heredocs: Heredoc[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (quote === '"' && c === '\\')
        i++; // \" does not close the span
      else if (c === quote) quote = null;
      continue;
    }
    // A heredoc opener is only an opener OUTSIDE quotes — this is why the
    // detection lives in here rather than over the raw line. `echo "use <<EOF"`
    // matched as one would start heredoc mode on a string, and every line to
    // the end of the script would be swallowed waiting for a terminator that
    // never comes. The quoted forms (`<<'EOF'`) are consumed by the match, so
    // their quotes never open a span either.
    if (c === '<' && line[i + 1] === '<') {
      const m = HEREDOC_OPENER.exec(line.slice(i));
      if (m) {
        heredocs.push({
          word: (m[1] ?? m[2] ?? m[3]) as string,
          dash: line[i + 2] === '-',
        });
        i += m[0].length - 1;
        live += ' ';
        continue;
      }
    }
    if (c === '\\') {
      i++;
      live += ' ';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      break; // trailing comment: the rest is prose, apostrophes and all
    } else {
      live += c;
    }
  }
  return { live, open: quote, heredocs };
}

/**
 * A pending heredoc: the terminator word, and whether the opener was the
 * indent-stripping `<<-` form.
 *
 * The form decides where the body ENDS, and getting that wrong leaks the body
 * into the command list. Bash ends a plain `<<WORD` only on a line that is
 * exactly WORD, so an indented `  EOF` inside the body is still body — matched
 * loosely, an `rm -rf /` two lines further down got reported as an invoked
 * command, which is a frightening entry for a reviewer to chase with nothing
 * behind it. `<<-` is matched more loosely than bash on purpose (bash strips
 * tabs, this strips any leading whitespace): looser can only end a body EARLY,
 * which over-reports, and this file's stated priority is that an under-report
 * is the worse direction — a missed command is a stub nobody writes.
 */
interface Heredoc {
  word: string;
  dash: boolean;
}

/** `<<WORD`, `<<-WORD`, `<<'WORD'` — the body that follows is data. */
const HEREDOC_OPENER =
  /^<<-?\s*(?:'([A-Za-z_][\w-]*)'|"([A-Za-z_][\w-]*)"|([A-Za-z_][\w-]*))/;

/** A line ending in an unescaped `\` continues into the next one. */
const CONTINUES = /(?:^|[^\\])(?:\\\\)*\\$/;

/**
 * Every `$( … )` body in a line, OUTER ONES INCLUDED.
 *
 * A `[^()]*` pattern only ever matches the innermost pair, so
 * `X=$(gh api $(build_url))` reported `build_url` and lost `gh` entirely — an
 * under-report, and the direction this file treats as the dangerous one: a
 * missed command is a stub the verifier never writes, so the extraction
 * reaches the network. Depth-counted instead, and every nesting level is
 * returned as its own body so each one's command word is found.
 */
function commandSubstitutionsOf(line: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] !== '$' || line[i + 1] !== '(') continue;
    // `$(( … ))` is ARITHMETIC, not a substitution, and nothing in it runs.
    // Read as one, `N=$((N + 1))` reported `N` as a command to stub — measured
    // across this repo's 434 run: steps, where it was the single largest
    // source of all-caps junk in the list. Skipping past the whole construct
    // costs the vanishingly rare `$( (a; b) )` subshell form, which is written
    // with a space in practice.
    if (line[i + 2] === '(') {
      const close = line.indexOf('))', i + 3);
      i = close === -1 ? line.length : close + 1;
      continue;
    }
    let depth = 0;
    for (let j = i + 1; j < line.length; j++) {
      if (line[j] === '(') depth++;
      else if (line[j] === ')') {
        depth--;
        if (depth === 0) {
          bodies.push(line.slice(i + 2, j));
          break;
        }
      }
    }
  }
  return bodies;
}

export function invokedCommandsOf(script: string): string[] {
  const seen = new Set<string>();
  const scanSegment = (seg: string) => {
    const words = seg
      .trim()
      .replace(/^[\s(]+/, '')
      .split(/\s+/);
    for (const word of words) {
      // Step over leading `name=value` assignment prefixes, any case — but
      // only when the value is CLOSED. `X=$(gh api $(u))` splits into
      // `X=$(gh`, `api`, …, and stepping over the first put `api` in command
      // position, reporting a subcommand as a command to stub. An unbalanced
      // `(` means the rest of this line is still inside the substitution, and
      // `commandSubstitutionsOf` above already reported what runs in there.
      if (/^[\w]+=/.test(word)) {
        const opens = (word.match(/\(/g) ?? []).length;
        const closes = (word.match(/\)/g) ?? []).length;
        if (opens > closes) break;
        continue;
      }
      // ...and over a `case` pattern label, whose command follows it on the
      // same line: `blocked) gh api x ;;` invokes `gh`, and stopping at the
      // label loses it. An UNDER-report is the worse direction here — a
      // missed `gh` is a stub the verifier does not write, so the extraction
      // reaches the network.
      if (/^[^()\s]+\)$/.test(word)) continue;
      if (/^[A-Za-z][\w.:+-]*$/.test(word) && !KEYWORDS.has(word)) {
        seen.add(word);
      }
      break; // only the command position; arguments are not invocations
    }
  };
  const scanLogicalLine = (rawLine: string, openQuote: '"' | "'" | null) => {
    const masked = maskExpressions(rawLine);
    // Command substitutions first, on the unstripped text — `body="$(sanitize
    // < f)"` is an assignment whose real invocation lives inside the `$()`.
    for (const body of commandSubstitutionsOf(masked)) scanSegment(body);
    const stripped = stripQuoted(masked, openQuote);
    const line = stripped.live.trim();
    if (line && !line.startsWith('#')) {
      for (const seg of line.split(/(?:\|\||&&|\||;)/)) scanSegment(seg);
    }
    return stripped;
  };

  const heredocQueue: Heredoc[] = [];
  const terminates = (rawLine: string, h: Heredoc): boolean =>
    h.dash ? rawLine.trim() === h.word : rawLine === h.word;
  let openQuote: '"' | "'" | null = null;
  // A backslash-continued command is ONE command: scanning the continuation
  // as its own line puts the next argument in command position, which is how
  // `apt-get install -y \` / `  libx11-dev` reported the package as a command.
  let pending: string | null = null;
  for (const rawLine of script.split('\n')) {
    if (heredocQueue.length > 0) {
      // a heredoc body is input to a command, not a list of them
      if (terminates(rawLine, heredocQueue[0])) heredocQueue.shift();
      continue;
    }
    // Annotated because the narrowing is loop-carried: `pending`'s type at
    // this line is the union of the entry value and the back edge below, and
    // that back edge is derived from `joined` — a cycle the checker gives up
    // on with an implicit `any` (TS7022) unless the type is stated outright.
    const joined: string = pending === null ? rawLine : pending + rawLine;
    if (CONTINUES.test(joined)) {
      pending = `${joined.slice(0, -1)} `;
      continue;
    }
    pending = null;
    const { open, heredocs } = scanLogicalLine(joined, openQuote);
    openQuote = open;
    heredocQueue.push(...heredocs);
  }
  if (pending !== null) scanLogicalLine(pending, openQuote);
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

/** The same, plus WHICH level won — the header labels it the way it labels env. */
function nearestScoped(
  ...values: Array<[EnvScope, unknown]>
): { value: string; scope: EnvScope } | undefined {
  const hit = values.find(([, v]) => typeof v === 'string');
  return hit ? { value: hit[1] as string, scope: hit[0] } : undefined;
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
 * An env value as the runner would hand it over. GitHub requires a scalar
 * here; a map or sequence is a malformed workflow, and `[object Object]` would
 * hide that behind a plausible-looking string. A bare `FOO:` is YAML null,
 * which the runner passes as the empty string.
 */
function envValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
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
    env[k] = envValue(v);
    sources[k] = scope;
  }
}

/**
 * Nearest level first — the step's own `env:`, then the job's, then the
 * workflow's. The merged map has no natural order, and merge order puts the
 * inherited entries first: on a workflow with a large top-level `env:` block
 * that buries the step's own vars, which are the ones a verifier reaches for.
 * `sort` is stable, so within a level the workflow's own order survives.
 */
const SCOPE_ORDER: Record<EnvScope, number> = { step: 0, job: 1, workflow: 2 };

function nearestFirst(
  env: Record<string, string>,
  sources: Record<string, EnvScope>,
): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(env).sort(
    (a, b) => SCOPE_ORDER[sources[a]] - SCOPE_ORDER[sources[b]],
  )) {
    ordered[k] = env[k];
  }
  return ordered;
}

export interface ExtractStepArgs {
  workflow: string;
  job: string;
  step: string;
  out: string;
}

export function runExtractStep(args: ExtractStepArgs): ExtractedStep {
  const wfPath = resolve(args.workflow);
  // Read and parse are separate failures with separate fixes: a missing path
  // reported as "cannot parse" sends the caller hunting for a YAML error.
  let text: string;
  try {
    text = readFileSync(wfPath, 'utf8');
  } catch (err) {
    throw new Error(
      `extract-step: cannot read ${args.workflow}: ${(err as Error).message}`,
    );
  }
  let doc: WorkflowDoc;
  try {
    doc = parse(text) as WorkflowDoc;
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
  const byName = steps.flatMap((s, i) =>
    s?.name === args.step || s?.id === args.step ? [i] : [],
  );
  // A job may legally hold two steps with the SAME name, and taking the first
  // is the failure this command's own header names: "picks the same-named step
  // from the wrong job". A/B extraction runs this twice, once per tree, and a
  // PR that adds or reorders a duplicate then has the two sides comparing
  // different steps while reporting on one. Ambiguity is refused out loud —
  // the index is always available and is never ambiguous.
  if (byName.length > 1) {
    throw new Error(
      `extract-step: step \`${args.step}\` is ambiguous in job \`${args.job}\` — ${byName.length} steps share that name (indices ${byName.join(', ')}); pass the index instead`,
    );
  }
  const index = /^\d+$/.test(args.step) ? Number(args.step) : (byName[0] ?? -1);
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
  const merged: Record<string, string> = {};
  const envSources: Record<string, EnvScope> = {};
  mergeEnv(doc, 'workflow', merged, envSources);
  mergeEnv(job, 'job', merged, envSources);
  mergeEnv(step, 'step', merged, envSources);
  const env = nearestFirst(merged, envSources);

  // GitHub's default for run steps on non-Windows runners is `bash -e {0}`; a
  // `shell:` at any level overrides it. Declaring `shell: bash` is NOT the
  // same as taking the default — the runner then uses
  // `bash --noprofile --norc -eo pipefail {0}`, so a pipeline whose middle
  // command fails aborts there and would not under a bare `set -e`. Carry the
  // distinction or the extraction measures a different script than the runner.
  const declaredShell = nearestString(
    step.shell,
    jobDefaults.shell,
    workflowDefaults.shell,
  );
  const shell = declaredShell ?? 'bash';
  // A `shell:` value is a command TEMPLATE (`perl {0}`), so only its first
  // word can go in a shebang; the full template is recorded beside it.
  const shellCommand = shell.trim().split(/\s+/)[0] || 'bash';
  const setLine =
    declaredShell === 'bash'
      ? 'set -eo pipefail'
      : shellCommand === 'bash' || shellCommand === 'sh'
        ? 'set -e'
        : undefined;
  const workingDir = nearestScoped(
    ['step', step['working-directory']],
    ['job', jobDefaults['working-directory']],
    ['workflow', workflowDefaults['working-directory']],
  );
  const workingDirectory = workingDir?.value;

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
    `#!/usr/bin/env ${shellCommand}`,
    ...commentLines(
      '# extracted verbatim from ',
      `${args.workflow} — job \`${args.job}\`, step \`${stepLabel}\``,
    ),
    ...(shell === shellCommand
      ? []
      : commentLines('# shell (runner invokes it this way): ', shell)),
    ...(setLine ? [setLine] : []),
    // A comment, not a `cd`, for the reason the env block is comments: the
    // value may hold `${{ … }}`, and this command substitutes nothing. But it
    // has to be HERE and not only in the metadata — this file's own argument
    // for reading all three levels is that a step run "in the wrong directory,
    // and nothing says so" is the transcription error it exists to remove, and
    // a reader of the script alone was told nothing.
    ...(workingDir
      ? commentLines(
          `# working-directory [${workingDir.scope}] (run FROM here): `,
          workingDir.value,
        )
      : []),
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
    // Every setting this command carries, not just the script and its env:
    // a `working-directory: ${{ github.workspace }}/x` left off the list is a
    // caller told there is nothing to stub, who then runs in a literal
    // `${{ … }}` directory. The `shell:` template is on the same footing.
    expressions: expressionsOf(
      script,
      ...Object.values(env),
      workingDirectory ?? '',
      shell,
    ),
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
        describe:
          'Step name, id, or 0-based index within the job (an all-digit value is always read as an index)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the executable script',
      }),
  handler: (argv) => {
    // Caught, like `base-tree` and `test-plan` next door. Every throw above is
    // a message written FOR the caller — read vs parse, no job vs no step vs
    // no `run:` — and letting it propagate re-frames all of them as "an
    // unexpected critical error" under a stack trace, which is the hunt those
    // messages exist to prevent.
    try {
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
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
