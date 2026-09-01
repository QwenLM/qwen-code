// Guards every self-hosted `runs-on` in .github/workflows against the set of
// lane labels the ECS fleet actually registers.
//
// Twice in 2026-08 a workflow shipped a `runs-on` label no runner carried, and
// both times the symptom was silence rather than a red job: GitHub queues such
// a job forever, `timeout-minutes` does not count queue time, and nothing in
// the run reports why. #10537 introduced `ecs-agent` before the fleet carried
// it — 65 review and autofix jobs sat queued for five hours. Separately,
// fifteen `sg-*` registrations lost `ecs-qwen` and idled through a saturation
// incident, invisible for the same reason.
//
// A checked-in registry cannot prove a label is registered — that lives in the
// runner configuration, not in this repo. What it does is make inventing one a
// deliberate, reviewable edit here, next to the note saying the label must be
// on the runners BEFORE the workflow lands. That ordering is the whole lesson.
//
// The guard parses the workflows with the real YAML parser and walks
// `jobs.*.runs-on`, resolving in-file `${{ matrix.* }}` / `${{ env.* }}`
// references to their defined values — three review rounds established that a
// hand-rolled line reader fails open on spellings it does not recognize, and
// that a YAML grammar's entrances cannot be enumerated shut. Everything the
// walk cannot resolve to concrete labels FAILS the suite rather than being
// skipped. `yaml` is the same root devDependency the sibling workflow tests
// (ci-runner-routing.test.mjs and six others) already import.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const workflowsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'workflows',
);

// Lane labels the ECS fleet registers. The convention — the shape, not a
// host inventory, because hosts rotate and the runners API is the only
// source of truth for which machines exist:
//
//   ecs-agent   review / autofix (6–8 hour budgets). Agent hosts carry it
//               on every registration.
//   ecs-qwen    CI (90 minute budget). CI hosts carry it on every
//               registration except runner 1.
//   ecs-light   seconds-long jobs (authorize, label, finalize-style):
//               runner 1 on each CI host, so the lane spans hosts and one
//               dead machine cannot silence it.
//
// A host is dedicated to one lane. Separating light from qwen is about
// head-of-line blocking, not capacity: the seconds-long jobs measured at
// ~71% of the queue and ~13% of the machine time, so they starve behind
// 90-minute Test jobs while costing almost nothing to move — a handful of
// light slots drains an 89-job peak in minutes at their ~15-second median.
// When a host is added or released, apply the shape above BEFORE any
// workflow change that assumes it, and never let a lane's slot count reach
// zero while a workflow still asks for it.
//
// Adding an entry here is NOT what makes a label exist. Register it on the
// runners first (`POST /repos/{owner}/{repo}/actions/runners/{id}/labels`),
// confirm the runners report it, and only then merge the workflow that asks
// for it. Comparisons are case-insensitive because GitHub's label matching
// is (the fleet registers `Linux`/`X64` capitalized while ci.yml routes with
// lowercase spellings, and both demonstrably match).
const REGISTERED_LANES = new Set([
  'ecs-light',
  'ecs-agent',
  'ecs-qwen',
  'ecs-win',
  // Not part of the per-host convention above: a single benchmark host
  // registered on its own for the DSW SWE-verified release lane.
  'qwen-benchmark-dsw-hk-eas',
]);

// Platform labels every self-hosted runner reports; they never name a lane.
const PLATFORM_LABELS = new Set(['self-hosted', 'linux', 'x64', 'windows']);

// Host-maintenance labels (update-ecs-runner-qwen.yml fans out over one
// `ecs-update-*` registration per host). Valid beside self-hosted, but they
// are not lanes: nothing routes ordinary work to them, so they are accepted
// without feeding the referenced-lane accounting.
const MAINTENANCE_LABEL = /^ecs-update-[A-Za-z0-9-]+$/i;

// GitHub-hosted runner images; outside this guard's jurisdiction.
const HOSTED_LABEL = /^(ubuntu|windows|macos)-[A-Za-z0-9._-]+$/i;

const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

// ci.yml's pick_runner step assembles the Linux runner set OFF the runs-on
// line (`ubuntu_runner='["self-hosted", …]'`) and four jobs consume it
// through `fromJSON(needs.classify_pr.outputs.ubuntu_runner)`. The consuming
// expressions carry only the hosted fallback, so the lane on the repo's main
// CI path is checkable ONLY at the assembly site. This scans run bodies for
// that exact whole-line shape — the one deliberate look inside `run:` text.
// Price of the textual scan, accepted and named: a matching line anywhere in
// a run body is validated as (and counts as a reference to) a lane set even
// if that code path is dead. A tripwire test below pins that the live ci.yml
// assignments keep matching this shape; if they are ever re-quoted or
// reshaped, the tripwire — not silence — says so.
function runnerSetAssignments(text) {
  return [
    ...text.matchAll(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)=(['"])(\[[^\n]*?\])\2\s*(?:#.*)?$/gm,
    ),
  ].map((m) => ({ name: m[1], raw: m[3] }));
}

// Quoted labels inside a bracketed literal. `*` (not `+`): an empty ""
// label must surface as an empty token and fail the set rules the way the
// direct-array spelling does, not vanish from the set.
function bracketTokens(raw) {
  return [...raw.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
}

// Splits a GitHub expression body on top-level `||`, then takes the LAST
// top-level `&&` operand of each part — GitHub's `cond && value || fallback`
// yields exactly those operands as possible runs-on VALUES, while the
// preceding `&&` operands are conditions (whose quoted scalars, e.g. the
// `!= 'true'` comparisons in ci.yml's classify_pr, are operands of the
// condition, not labels, and must not be judged). Quote state honors the
// GitHub-expression `''` escape; parens/brackets nest. For each || part
// every operand that can BE the value is judged; stripping a parenthesized
// value's parens re-exposes top-level operators, so recurse until each arm
// is operator-free.
function valueArms(body) {
  const parts = [[]];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && body[i + 1] === "'") {
          parts[parts.length - 1].push("''");
          i += 1;
          continue;
        }
        quote = null;
      }
      parts[parts.length - 1].push(ch);
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      parts[parts.length - 1].push(ch);
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && (ch === '|' || ch === '&') && body[i + 1] === ch) {
      parts[parts.length - 1].push(ch === '|' ? '\u0000OR' : '\u0000AND');
      parts.push([]);
      i += 1;
      continue;
    }
    parts[parts.length - 1].push(ch);
  }
  const tokens = parts.map((p) => p.join(''));
  const arms = [];
  let current = [];
  for (const tok of tokens) {
    if (tok.endsWith('\u0000OR')) {
      current.push(tok.slice(0, -3));
      arms.push(current);
      current = [];
    } else if (tok.endsWith('\u0000AND')) {
      current.push(tok.slice(0, -4));
    } else {
      current.push(tok);
    }
  }
  arms.push(current);
  const out = [];
  for (const ops of arms) {
    let v = ops[ops.length - 1].trim();
    while (v.startsWith('(') && v.endsWith(')')) {
      v = v.slice(1, -1).trim();
    }
    if (/\|\||&&/.test(stripQuotesAndParens(v))) {
      out.push(...valueArms(v));
    } else {
      out.push(v);
    }
  }
  return out;
}

// The arm text with quoted spans and paren/bracket bodies blanked, so an
// operator test sees only TOP-LEVEL operators.
function stripQuotesAndParens(arm) {
  let depth = 0;
  let quote = null;
  let out = '';
  for (let i = 0; i < arm.length; i += 1) {
    const ch = arm[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && arm[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      depth -= 1;
      continue;
    }
    if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

const WHOLE_EXPRESSION = /^\$\{\{[\s\S]*\}\}$/;
const MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/;
const ENV_REF = /^\$\{\{\s*env\.([A-Za-z0-9_-]+)\s*\}\}$/;

function matrixValues(job, key) {
  const matrix = job?.strategy?.matrix;
  if (!matrix || typeof matrix !== 'object') {
    return null;
  }
  const values = [];
  if (Array.isArray(matrix[key])) {
    values.push(...matrix[key]);
  }
  for (const row of Array.isArray(matrix.include) ? matrix.include : []) {
    if (row && typeof row === 'object' && key in row) {
      values.push(row[key]);
    }
  }
  return values.length > 0 ? values : null;
}

function envValue(doc, job, key) {
  for (const scope of [job?.env, doc?.env]) {
    if (scope && typeof scope === 'object' && key in scope) {
      return scope[key];
    }
  }
  return null;
}

// Turns one workflow into a test plan: a `problems` entry FAILS the suite
// (either an unregistered/ill-formed lane set, or a value the walk cannot
// resolve — fail closed, never skipped), `lanes` records registry references.
// Pure — no `it()` registration — so the fail-closed describe below executes
// the outcomes directly and proves them.
function laneTestPlan(file, text) {
  const problems = [];
  const lanes = [];
  const oks = []; // parsed sets that passed, for the synthetic assertions

  const problem = (name, message) => problems.push({ name, message });

  // A full set of concrete labels, ready for the registry rules.
  function checkSet(labels, origin) {
    const lc = labels.map((l) => String(l).toLowerCase());
    // An empty set matches no runner (and classified nothing) — vouching it
    // would contradict the fail-closed contract outright.
    if (lc.length === 0) {
      problem(
        `${file}: ${origin} is an empty label set`,
        `an empty label set matches no runner; the job queues forever ` +
          `with no error.`,
      );
      return;
    }
    // A label containing a comma or a quote can never match a registered
    // label; it is one unmatchable string, whatever prefix it starts with.
    const unmatchable = labels.filter((l) => /[,'"]/.test(String(l)));
    if (unmatchable.length > 0) {
      problem(
        `${file}: ${origin} has an unmatchable label`,
        `[${unmatchable.join('; ')}] can never match a runner label — ` +
          `the job queues forever with no error.`,
      );
      return;
    }
    // GitHub routes a self-hosted job only to runners carrying EVERY listed
    // label, and no runner carries two operating systems — a copy-edit that
    // adds the new OS label without removing the old produces a set no
    // machine can match, queueing forever. Case-folded, per the header.
    if (lc.includes('linux') && lc.includes('windows')) {
      problem(
        `${file}: ${origin} mixes mutually exclusive platform labels`,
        `label set [${labels.join(', ')}] asks for linux AND windows on one ` +
          `runner; no such machine can exist, so the job queues forever ` +
          `with no error.`,
      );
      return;
    }
    if (!lc.includes('self-hosted')) {
      if (lc.every((l) => HOSTED_LABEL.test(l))) {
        return; // hosted set — not this guard's jurisdiction
      }
      problem(
        `${file}: ${origin} is neither hosted nor self-hosted`,
        `label set [${labels.join(', ')}] names no self-hosted and no known ` +
          `hosted image — an invented label here queues forever with no error.`,
      );
      return;
    }
    const rest = labels.filter(
      (l) => !PLATFORM_LABELS.has(String(l).toLowerCase()),
    );
    if (rest.length === 1 && MAINTENANCE_LABEL.test(rest[0])) {
      oks.push(origin);
      return; // host-maintenance fan-out, valid but not a lane
    }
    if (rest.length !== 1) {
      problem(
        `${file}: ${origin} must name exactly one lane`,
        `expected one lane label beside the platform labels, got ` +
          `[${rest.join(', ')}]`,
      );
      return;
    }
    const lane = String(rest[0]).toLowerCase();
    if (!REGISTERED_LANES.has(lane)) {
      problem(
        `${file}: ${origin} names an unregistered lane`,
        `"${rest[0]}" is not a registered lane. Register the label on the ` +
          `runners first, then add it to REGISTERED_LANES in this file. A ` +
          `label no runner carries makes the job queue forever with no error.`,
      );
      return;
    }
    lanes.push(lane);
    oks.push(origin);
  }

  // One string label on its own (a scalar runs-on, or a resolved matrix/env
  // value).
  function checkScalarLabel(value, origin) {
    const t = String(value).trim();
    if (HOSTED_LABEL.test(t)) {
      return;
    }
    if (t.startsWith('[')) {
      problem(
        `${file}: ${origin} is a quoted literal array`,
        `'${t}' is a STRING scalar — GitHub reads the whole thing as one ` +
          `label no runner carries. Unquote the flow sequence.`,
      );
      return;
    }
    problem(
      `${file}: ${origin} is a single non-hosted label`,
      `'${t}' routes to no known hosted image, and a bare self-hosted ` +
        `label carries no checkable lane. Write the full quoted label set.`,
    );
  }

  function checkValue(value, job, origin) {
    if (Array.isArray(value)) {
      const dynamic = value.filter((l) => String(l).includes('${{'));
      if (dynamic.length === 0) {
        checkSet(value, origin);
        return;
      }
      if (dynamic.length > 1) {
        problem(
          `${file}: ${origin} has multiple dynamic labels`,
          `cannot resolve more than one expression label in a set: ` +
            `[${dynamic.join(', ')}]`,
        );
        return;
      }
      const resolved = resolveExpression(String(dynamic[0]), job);
      if (resolved === null) {
        problem(
          `${file}: ${origin} has an unresolvable dynamic label`,
          `'${dynamic[0]}' does not resolve to values defined in this file ` +
            `— the guard cannot vouch for the lane, so it fails closed.`,
        );
        return;
      }
      for (const v of resolved) {
        const expanded = value.map((l) => (l === dynamic[0] ? v : l));
        if (expanded.some((l) => Array.isArray(l))) {
          problem(
            `${file}: ${origin} resolves a label to a list`,
            `'${dynamic[0]}' resolves to a nested array inside a label set.`,
          );
          return;
        }
        checkSet(expanded, `${origin} (with ${dynamic[0]} = ${v})`);
      }
      return;
    }
    if (typeof value === 'string') {
      const t = value.trim();
      if (WHOLE_EXPRESSION.test(t)) {
        // Judge every VALUE arm of the expression, not just its embedded
        // arrays: `cond && fromJSON('[…]') || 'ecs-x'` routes the quoted
        // scalar arm when the condition is false, so an unjudged arm is a
        // fail-open door (sdk-java.yml already routes with `|| 'ubuntu-
        // latest'` and `|| matrix.os` arms).
        const body = t.replace(/^\$\{\{/, '').replace(/\}\}$/, '');
        for (const arm of valueArms(body)) {
          // Closed allowlist of arm shapes; anything else fails closed.
          // Order matters: a quoted scalar is judged as the STRING GitHub
          // reads it as, before any bracket text inside it can be mistaken
          // for a label set (a quoted literal array arm is one label no
          // runner carries).
          const scalar =
            arm.match(/^'((?:[^']|'')*)'$/) ?? arm.match(/^"([^"]*)"$/);
          if (scalar) {
            checkScalarLabel(
              scalar[1].replaceAll("''", "'"),
              `${origin} → ${arm}`,
            );
            continue;
          }
          const call = arm.match(/^fromJSON\(([\s\S]*)\)$/);
          if (call) {
            // Classify every operand fromJSON can evaluate — the || parts
            // of the call body, parens stripped by valueArms. Each operand
            // must be one of: a quoted array literal (judged as a label
            // set), a needs-output reference RESOLVED BY NAME to a producer
            // assignment in this file, or a matrix./env. reference resolved
            // to its in-file value. Anything else — format(), toJSON(), a
            // reference the scan cannot resolve — fails closed. Judging by
            // name (not "some assembly exists") is the point: a producer
            // written in a shape the scan cannot read must turn the
            // consumer red, not ride on an unrelated assembly.
            for (const operand of valueArms(call[1])) {
              const lit =
                operand.match(/^'((?:[^']|'')*)'$/) ??
                operand.match(/^"([^"]*)"$/);
              if (lit) {
                const inner = lit[1].replaceAll("''", "'").trim();
                if (!inner.startsWith('[') || !inner.endsWith(']')) {
                  problem(
                    `${file}: ${origin} feeds fromJSON a non-array literal`,
                    `'${inner}' is not a JSON label array — fromJSON of ` +
                      `this cannot be a runner set the guard can vouch for.`,
                  );
                  continue;
                }
                const tokens = bracketTokens(inner);
                if (tokens.length === 0 && inner.slice(1, -1).trim() !== '') {
                  problem(
                    `${file}: ${origin} embeds an unquoted array`,
                    `${inner} has no quoted labels the guard can read.`,
                  );
                  continue;
                }
                checkSet(tokens, `${origin} → ${inner}`);
                continue;
              }
              const needsRef = operand.match(
                /^needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/,
              );
              if (needsRef) {
                const [, producerJob, outName] = needsRef;
                const producers = (jobAssemblies.get(producerJob) ?? []).filter(
                  (a) => a.name === outName,
                );
                if (
                  (jobOpaqueWrites.get(producerJob) ?? new Set()).has(outName)
                ) {
                  problem(
                    `${file}: ${origin} consumes a runner set with an unreadable write`,
                    `job '${producerJob}' assigns '${outName}' in a shape ` +
                      `the assembly scan cannot read (command substitution, ` +
                      `variable copy, or a continuation), so a scannable ` +
                      `literal beside it cannot vouch for what actually ` +
                      `feeds the output — the guard fails closed.`,
                  );
                  continue;
                }
                if (producers.length === 0) {
                  problem(
                    `${file}: ${origin} consumes a runner set with no checkable producer`,
                    `'${operand}' reads output '${outName}' of job ` +
                      `'${producerJob}', but that job has no whole-line ` +
                      `${outName}='["…"]' assignment the assembly scan can ` +
                      `vouch for — the lane behind the indirection is ` +
                      `unchecked, so the guard fails closed.`,
                  );
                  continue;
                }
                for (const a of producers) {
                  judgeAssembly(a, ` (consumed by ${origin})`);
                }
                continue;
              }
              const opRef =
                operand.match(/^matrix\.([A-Za-z0-9_-]+)$/) ??
                operand.match(/^env\.([A-Za-z0-9_-]+)$/);
              if (opRef) {
                const resolved = operand.startsWith('matrix.')
                  ? matrixValues(job, opRef[1])
                  : (() => {
                      const v = envValue(doc, job, opRef[1]);
                      return v === null ? null : [v];
                    })();
                if (resolved === null) {
                  problem(
                    `${file}: ${origin} is an unresolvable expression`,
                    `'${operand}' resolves to nothing defined in this file ` +
                      `— the guard cannot vouch for the operand, so it ` +
                      `fails closed.`,
                  );
                  continue;
                }
                for (const v of resolved) {
                  if (Array.isArray(v)) {
                    checkSet(v, `${origin} (${operand})`);
                  } else if (String(v).trim().startsWith('[')) {
                    checkSet(
                      bracketTokens(String(v)),
                      `${origin} (${operand} = ${v})`,
                    );
                  } else {
                    problem(
                      `${file}: ${origin} feeds fromJSON a non-array value`,
                      `'${operand}' resolves to '${v}', which is not a ` +
                        `JSON label array.`,
                    );
                  }
                }
                continue;
              }
              problem(
                `${file}: ${origin} has an unreadable fromJSON operand`,
                `'${operand}' is neither a quoted array literal, a ` +
                  `needs-output reference, nor a matrix./env. reference ` +
                  `this guard can resolve — it fails closed.`,
              );
            }
            continue;
          }
          const ref =
            arm.match(/^matrix\.([A-Za-z0-9_-]+)$/) ??
            arm.match(/^env\.([A-Za-z0-9_-]+)$/);
          if (ref) {
            const resolved = arm.startsWith('matrix.')
              ? matrixValues(job, ref[1])
              : (() => {
                  const v = envValue(doc, job, ref[1]);
                  return v === null ? null : [v];
                })();
            if (resolved === null) {
              problem(
                `${file}: ${origin} is an unresolvable expression`,
                `'${arm}' resolves to nothing defined in this file — the ` +
                  `guard cannot vouch for the arm, so it fails closed.`,
              );
              continue;
            }
            for (const v of resolved) {
              checkValue(v, job, `${origin} (${arm} = ${JSON.stringify(v)})`);
            }
            continue;
          }
          problem(
            `${file}: ${origin} is an unresolvable expression`,
            `value arm '${arm}' is none of the judgeable shapes (quoted ` +
              `scalar, fromJSON(...) with a literal array, bare matrix./` +
              `env. reference) — the guard cannot vouch for it, so it ` +
              `fails closed.`,
          );
        }
        return;
      }
      if (t.includes('${{')) {
        problem(
          `${file}: ${origin} mixes text and expression`,
          `'${t}' is neither a plain label nor a whole-value expression.`,
        );
        return;
      }
      checkScalarLabel(t, origin);
      return;
    }
    problem(
      `${file}: ${origin} has an unreadable type`,
      `runs-on is a ${typeof value}; expected a string or a label list.`,
    );
  }

  function resolveExpression(expr, job) {
    const m = expr.match(MATRIX_REF);
    if (m) {
      return matrixValues(job, m[1]);
    }
    const e = expr.match(ENV_REF);
    if (e) {
      const v = envValue(doc, job, e[1]);
      return v === null ? null : [v];
    }
    return null;
  }

  const judgedAssemblies = new Set();
  function judgeAssembly(a, why) {
    if (judgedAssemblies.has(a)) {
      return;
    }
    judgedAssemblies.add(a);
    checkSet(bracketTokens(a.raw), `runner-set assignment ${a.raw}${why}`);
  }

  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    problem(
      `${file}: guard cannot parse the workflow`,
      `YAML parse failed (${error.message.split('\n')[0]}) — nothing in ` +
        `this file can be vouched for.`,
    );
    return { problems, lanes, oks };
  }

  // Assemblies are attributed to the JOB whose run bodies contain them — a
  // consumer reads needs.<job>.outputs.<name>, and only that job's writes
  // can feed the output, so a same-named literal in another job is a decoy,
  // not a producer. Alongside the scannable literals, every OTHER
  // assignment line to the same variable (command substitution, variable
  // copy, a continuation of a multi-line assembly) is recorded as
  // unreadable: when one exists for a consumed name, a scannable literal
  // beside it cannot vouch for what actually reached $GITHUB_OUTPUT.
  const jobAssemblies = new Map();
  const jobOpaqueWrites = new Map();
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    const assemblies = [];
    const opaque = new Set();
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (typeof step?.run !== 'string') {
        continue;
      }
      assemblies.push(...runnerSetAssignments(step.run));
      for (const line of step.run.split('\n')) {
        const write = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
        if (
          write &&
          !/^\s*[A-Za-z_][A-Za-z0-9_]*=(['"])\[[^\n]*?\]\1\s*(?:#.*)?$/.test(
            line,
          )
        ) {
          opaque.add(write[1]);
        }
      }
    }
    jobAssemblies.set(jobName, assemblies);
    jobOpaqueWrites.set(jobName, opaque);
  }

  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    if (!job || typeof job !== 'object') {
      continue;
    }
    const runsOn = job['runs-on'];
    if (runsOn === undefined) {
      if (typeof job.uses === 'string') {
        continue; // reusable-workflow call; the callee declares its runners
      }
      problem(
        `${file}: job ${jobName} has no runs-on`,
        `neither runs-on nor uses — the guard cannot tell where this runs.`,
      );
      continue;
    }
    checkValue(runsOn, job, `jobs.${jobName}.runs-on`);
  }

  for (const perJob of jobAssemblies.values()) {
    for (const a of perJob) {
      if (bracketTokens(a.raw).some((l) => l.toLowerCase() === 'self-hosted')) {
        judgeAssembly(a, '');
      }
    }
  }

  return { problems, lanes, oks };
}

// How many enforcement tests the main loop registered; the fail-closed
// describe asserts this is live, because deleting the registration loop
// otherwise leaves every real-workflow check dead while the synthetic
// tests (which call laneTestPlan directly) stay green.
let registeredEnforcementTests = 0;

describe('self-hosted runs-on labels', () => {
  const found = new Map();

  for (const file of workflowFiles) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const { problems, lanes, oks } = laneTestPlan(file, text);
    for (const p of problems) {
      registeredEnforcementTests += 1;
      it(p.name, () => {
        assert.fail(p.message);
      });
    }
    for (const origin of oks) {
      registeredEnforcementTests += 1;
      it(`${file}: ${origin} names a registered lane`, () => {});
    }
    for (const lane of lanes) {
      found.set(lane, (found.get(lane) ?? 0) + 1);
    }
  }

  it('every registered lane is still referenced by a workflow', () => {
    for (const lane of REGISTERED_LANES) {
      assert.ok(
        found.has(lane),
        `"${lane}" is registered here but no workflow asks for it. Either a ` +
          `lane lost its last consumer (drop it here and free the runners) ` +
          `or a routing edit demoted it by accident.`,
      );
    }
  });

  it('the pick_runner assembly in ci.yml still matches the scanned shape', () => {
    const text = readFileSync(join(workflowsDir, 'ci.yml'), 'utf8');
    const selfHosted = runnerSetAssignments(text).filter((a) =>
      /self-hosted/i.test(a.raw),
    );
    assert.ok(selfHosted.length >= 2);
    // The consumers read `ubuntu_runner`; the scan must see the producer
    // under that exact name or the by-name resolution is checking nothing.
    assert.ok(
      selfHosted.every((a) => a.name === 'ubuntu_runner'),
      `expected the two pick_runner assignments to match the assignment ` +
        `scan; found ${selfHosted.length}. If they were re-quoted or ` +
        `reshaped, update runnerSetAssignments so the main CI routing lane ` +
        `stays checked.`,
    );
  });
});

// The fail-closed contract, pinned on synthetic workflows so it cannot rot.
// Two families: values the walk READS and judges (an invented lane is caught
// whatever the YAML spelling), and values it cannot vouch for (which must
// land in `problems`, never be skipped). Every case here was verified to
// slip an invented lane past an earlier revision of this guard.
describe('laneTestPlan fail-closed behavior', () => {
  const wrap = (runsOn, extra = '') =>
    `jobs:\n  a:\n    runs-on: ${runsOn}\n${extra}`;

  const caught = [
    [
      'block sequence',
      `\n      - self-hosted\n      - linux\n      - x64\n      - ecs-invented`,
    ],
    ['unquoted flow sequence', `[self-hosted, linux, x64, ecs-invented]`],
    [
      'mixed quoted/unquoted flow sequence',
      `['self-hosted', 'linux', 'x64', 'ecs-qwen', ecs-invented]`,
    ],
    [
      'multi-line flow sequence',
      `[\n      'self-hosted', 'linux',\n      'x64', 'ecs-invented']`,
    ],
    [
      'trailing comment',
      `['self-hosted', 'linux', 'x64', 'ecs-invented'] # note`,
    ],
  ];
  const blob = (p) => `${p.name} ${p.message}`;
  for (const [name, runsOn] of caught) {
    it(`catches an invented lane in a ${name}`, () => {
      const { problems } = laneTestPlan('probe.yml', wrap(runsOn));
      assert.equal(problems.length, 1);
      assert.match(
        blob(problems[0]),
        /not a registered lane|expected one lane label/,
      );
    });
  }

  it('catches an invented lane behind a flow-mapping job', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `jobs:\n  a: {runs-on: ['self-hosted', 'linux', 'x64', 'ecs-invented'], steps: []}`,
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  it('catches an invented lane behind a quoted key', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `jobs:\n  a:\n    "runs-on": ['self-hosted', 'linux', 'x64', 'ecs-invented']`,
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  // In-file resolution: constants bound through env/matrix are read, not
  // exempted — GitHub evaluates them, so the guard must too.
  it('catches an invented lane bound through env', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  LANE: ecs-invented\njobs:\n  a:\n    runs-on: ['self-hosted', 'linux', 'x64', '\${{ env.LANE }}']`,
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  it('catches an invented lane bound through a matrix', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `['self-hosted', 'linux', 'x64', '\${{ matrix.runner }}']`,
        `    strategy:\n      matrix:\n        runner: ['ecs-invented']\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  it('catches an invented lane in a whole-value matrix runs-on', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ matrix.runner }}'`,
        `    strategy:\n      matrix:\n        include:\n          - runner: ['self-hosted', 'linux', 'x64', 'ecs-invented']\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  // R4-1: the expression's VALUE ARMS are judged, not just its arrays — a
  // quoted-scalar or bare-reference fallback arm routes when the condition
  // is false, so it must pass the same rules.
  it('catches an invented lane riding a scalar fallback arm', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || ''ecs-new-lane'' }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /single non-hosted label/);
  });

  it('catches an invented lane riding a bare matrix fallback arm', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || matrix.os }}'`,
        `    strategy:\n      matrix:\n        os: ['ecs-invented']\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /single non-hosted label/);
  });

  it('accepts the hosted scalar fallback arm sdk-java routes with', () => {
    const plan = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || ''ubuntu-latest'' }}'`,
      ),
    );
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.lanes, ['ecs-qwen']);
  });

  // R5-1: the arm ladder is a closed allowlist. Each demonstrated escape is
  // pinned: an all-caps array in a VALUE arm is judged (condition operands
  // never reach the ladder, so no exemption exists to hide behind), a quoted
  // literal array arm is the one string label GitHub reads it as, and a
  // parenthesized (a || b) value judges both alternatives.
  it('catches an all-caps invented lane in a fromJSON arm', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || fromJSON(''["MYLANE"]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /neither hosted nor self-hosted/);
  });

  it('catches a quoted literal array riding a fallback arm', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || ''["self-hosted", "linux", "x64", "ecs-light"]'' }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /quoted literal array/);
  });

  it('judges both alternatives of a parenthesized value', () => {
    const { problems, lanes } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ (matrix.os || fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'')) }}'`,
        `    strategy:\n      matrix:\n        os: ['ecs-invented']\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /single non-hosted label/);
    assert.deepEqual(lanes, ['ecs-qwen']);
  });

  // R6-1: a consumer arm (fromJSON over an indirect operand) is vouched only
  // by a producer assignment the assembly scan can read in the same file.
  const consumer = `'\${{ fromJSON(needs.a.outputs.ubuntu_runner || ''["ubuntu-latest"]'') }}'`;
  const producer = (q) =>
    `    steps:\n      - run: |-\n          ubuntu_runner=${q}["self-hosted", "linux", "x64", "ecs-qwen"]${q}\n`;

  it('accepts the consumer shape when its producer assignment is present', () => {
    const plan = laneTestPlan('probe.yml', wrap(consumer, producer("'")));
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.lanes, ['ecs-qwen']);
  });

  it('reads a double-quoted producer assignment the same way', () => {
    const plan = laneTestPlan('probe.yml', wrap(consumer, producer('"')));
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.lanes, ['ecs-qwen']);
  });

  it('fails closed on the consumer shape with no checkable producer', () => {
    const { problems } = laneTestPlan('probe.yml', wrap(consumer));
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('catches an invented lane in a double-quoted producer assignment', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    steps:\n      - run: |-\n          ubuntu_runner="["self-hosted", "linux", "x64", "ecs-invented"]"\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  // R7 pins. The consumer vouch is BY NAME: an assembly under a different
  // variable cannot vouch for the consumed output.
  const unrelatedProducer = `    steps:\n      - run: |-\n          gpu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]'\n`;

  it('fails closed when only an unrelated-name assembly exists', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(consumer, unrelatedProducer),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('strips operand parens before classifying (no gate bypass)', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON((needs.a.outputs.ubuntu_runner) || ''["ubuntu-latest"]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('resolves an env operand and judges its lane', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  RUNNER_SET: '["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
        wrap(
          `'\${{ fromJSON(env.RUNNER_SET || ''["ubuntu-latest"]'') }}'`,
          unrelatedProducer,
        ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /not a registered lane/);
  });

  it('fails closed on a computed fromJSON operand', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON(format(''["self-hosted", {0}, "x64", "ecs-qwen"]'', ''"linux"'')) }}'`,
        unrelatedProducer,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable fromJSON operand/);
  });

  // R8: producer resolution is attributed to the JOB the consumer names.
  it('fails closed on a cross-job same-named decoy assembly', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(consumer) +
        `  decoy:\n    runs-on: ubuntu-latest\n    steps:\n` +
        `      - run: |-\n` +
        `          ubuntu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]'\n`,
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('fails closed when the consumed name also has an unreadable write', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    steps:\n      - run: |-\n` +
          `          ubuntu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]'\n` +
          `          ubuntu_runner="$(jq -r .runner config.json)"\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable write/);
  });

  // R7-1: prefix exemptions are end-anchored; a comma'd string is one
  // unmatchable label, never an exemption.
  it("catches a comma'd hosted scalar", () => {
    const { problems } = laneTestPlan('probe.yml', wrap(`ubuntu-latest, evil`));
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /single non-hosted label/);
  });

  it("catches a comma'd hosted array element", () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(`['ubuntu-latest, evil']`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unmatchable label/);
  });

  it("catches a comma'd maintenance label", () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(`['self-hosted', 'linux', 'x64', 'ecs-update-sg, evil']`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unmatchable label/);
  });

  // RA-3: an empty "" label must fail like the direct-array spelling does,
  // not vanish from the extracted set.
  it('keeps an empty-string label visible in a fromJSON arm', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen", ""]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /exactly one lane/);
  });

  // R6-2: no runner carries two operating systems; a set demanding both can
  // match no machine and queues forever. Lane is registered on purpose so
  // only the exclusivity check can catch it.
  it('catches mutually exclusive platform labels', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(`['self-hosted', 'linux', 'windows', 'x64', 'ecs-qwen']`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /mutually exclusive platform labels/);
  });

  it('catches mixed-case exclusive platform labels', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(`['self-hosted', 'Linux', 'WINDOWS', 'X64', 'ecs-qwen']`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /mutually exclusive platform labels/);
  });

  it('catches a second static lane smuggled beside a registered one', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(`['self-hosted', 'linux', 'x64', 'ecs-qwen', 'ecs-invented']`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /expected one lane label/);
  });

  it('catches an invented non-hosted set in an expression arm', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || fromJSON(''["ecs-invented"]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /neither hosted nor self-hosted/);
  });

  const refused = [
    [
      'whole-value quoted literal array',
      `'["self-hosted", "linux", "x64", "ecs-qwen"]'`,
      /quoted literal array/,
    ],
    ['bare unknown scalar', `ecs-invented`, /single non-hosted label/],
    ['bare self-hosted', `self-hosted`, /single non-hosted label/],
    [
      'unresolvable env reference',
      `['self-hosted', 'linux', 'x64', '\${{ env.LANE }}']`,
      /unresolvable dynamic label/,
    ],
    [
      'unresolvable whole-value expression',
      `'\${{ vars.LIGHT_RUNNER }}'`,
      /unresolvable expression/,
    ],
    [
      'text mixed with an expression',
      `prefix-\${{ matrix.runner }}`,
      /mixes text and expression/,
    ],
    ['empty flow sequence', `[]`, /empty label set/],
  ];
  for (const [name, runsOn, message] of refused) {
    it(`refuses to vouch for a ${name}`, () => {
      const { problems, lanes } = laneTestPlan('probe.yml', wrap(runsOn));
      assert.equal(lanes.length, 0);
      assert.equal(problems.length, 1);
      assert.match(blob(problems[0]), message);
    });
  }

  it('refuses to vouch for an unparseable workflow', () => {
    const { problems } = laneTestPlan('probe.yml', `jobs:\n  a: [unclosed`);
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /cannot parse/);
  });

  const accepted = [
    [
      'the conditional expression ci.yml routes with',
      `'\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || fromJSON(''["ubuntu-latest"]'') }}'`,
      ['ecs-qwen'],
    ],
    [
      `a static quoted sequence`,
      `['self-hosted', 'linux', 'x64', 'ecs-agent']`,
      ['ecs-agent'],
    ],
    [
      'a capitalized spelling (GitHub label matching is case-insensitive)',
      `['self-hosted', 'Linux', 'X64', 'ECS-QWEN']`,
      ['ecs-qwen'],
    ],
    [
      'a registered lane with a trailing comment',
      `['self-hosted', 'linux', 'x64', 'ecs-qwen'] # was ecs-old`,
      ['ecs-qwen'],
    ],
    [`a hosted scalar`, `ubuntu-latest`, []],
    [`a hosted whole-value matrix fan-out`, `'\${{ matrix.os }}'`, []],
  ];
  const extras = {
    'a hosted whole-value matrix fan-out': `    strategy:\n      matrix:\n        os: ['ubuntu-latest', 'macos-14']\n`,
  };
  for (const [name, runsOn, lanes] of accepted) {
    it(`accepts ${name}`, () => {
      const plan = laneTestPlan('probe.yml', wrap(runsOn, extras[name] ?? ''));
      assert.deepEqual(plan.problems, []);
      assert.deepEqual(plan.lanes, lanes);
    });
  }

  it('accepts the maintenance fan-out shape without counting a lane', () => {
    const { problems, lanes, oks } = laneTestPlan(
      'probe.yml',
      wrap(
        `['self-hosted', 'linux', 'x64', '\${{ matrix.runner }}']`,
        `    strategy:\n      matrix:\n        runner: ['ecs-update-sg', 'ecs-update-hk-1']\n`,
      ),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(lanes, []);
    assert.equal(oks.length, 2);
  });

  it('accepts the pick_runner assignment and counts its lane', () => {
    const { problems, lanes } = laneTestPlan(
      'probe.yml',
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n` +
        `      - run: |-\n` +
        `          ubuntu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]'\n`,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(lanes, ['ecs-qwen']);
  });

  it('the main loop actually registered enforcement tests', () => {
    // Deleting the registration loop above leaves every real-workflow check
    // dead while these synthetic tests stay green; this is the tripwire.
    assert.ok(
      registeredEnforcementTests > 0,
      `no enforcement tests were registered from the real workflows — the ` +
        `registration loop in the main describe is gone or neutered.`,
    );
  });
});
