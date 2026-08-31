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
const MAINTENANCE_LABEL = /^ecs-update-/i;

// GitHub-hosted runner images; outside this guard's jurisdiction.
const HOSTED_LABEL = /^(ubuntu|windows|macos)-/i;

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
    ...text.matchAll(/^\s*[A-Za-z_][A-Za-z0-9_]*='(\[[^\n]*\])'\s*$/gm),
  ].map((m) => m[1]);
}

// Extracts the JSON-ish label arrays embedded in a GitHub expression, e.g.
// both arms of
//   ${{ cond && fromJSON('["self-hosted", "linux", "x64", "ecs-qwen"]')
//            || fromJSON('["ubuntu-latest"]') }}
// Returns null when the expression embeds no array at all.
function embeddedArrays(expr) {
  const groups = [...expr.matchAll(/\[[^[\]]*\]/g)].map((m) => m[0]);
  if (groups.length === 0) {
    return null;
  }
  return groups.map((g) => {
    const tokens = [...g.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    return { raw: g, tokens };
  });
}

// Splits a GitHub expression body on top-level `||`, then takes the LAST
// top-level `&&` operand of each part — GitHub's `cond && value || fallback`
// yields exactly those operands as possible runs-on VALUES, while the
// preceding `&&` operands are conditions (whose quoted scalars, e.g. the
// `!= 'true'` comparisons in ci.yml's classify_pr, are operands of the
// condition, not labels, and must not be judged). Quote state honors the
// GitHub-expression `''` escape; parens/brackets nest.
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
  // value = last && operand of each || part, outer parens stripped
  return arms.map((ops) => {
    let v = ops[ops.length - 1].trim();
    while (v.startsWith('(') && v.endsWith(')')) {
      v = v.slice(1, -1).trim();
    }
    return v;
  });
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
          const arrays = embeddedArrays(arm);
          if (arrays !== null) {
            for (const { raw, tokens } of arrays) {
              // An all-caps token list (["OWNER","MEMBER","COLLABORATOR"])
              // is a contains()-operand — author associations, not runner
              // labels. Runner labels are lowercase-with-hyphens; nothing
              // the fleet registers matches /^[A-Z_]+$/.
              if (
                tokens.length > 0 &&
                tokens.every((t2) => /^[A-Z_]+$/.test(t2))
              ) {
                continue;
              }
              if (tokens.length === 0) {
                problem(
                  `${file}: ${origin} embeds an unquoted array`,
                  `${raw} inside the expression has no quoted labels the ` +
                    `guard can read.`,
                );
                continue;
              }
              checkSet(tokens, `${origin} → ${raw}`);
            }
            continue;
          }
          const scalar =
            arm.match(/^'((?:[^']|'')*)'$/) ?? arm.match(/^"([^"]*)"$/);
          if (scalar) {
            checkScalarLabel(
              scalar[1].replaceAll("''", "'"),
              `${origin} → ${arm}`,
            );
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
            `value arm '${arm}' embeds no label array, is not a quoted ` +
              `scalar, and resolves to nothing defined in this file — the ` +
              `guard cannot vouch for it, so it fails closed. Inline the ` +
              `label set, or resolve it from matrix/env values defined in ` +
              `this workflow.`,
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

  for (const raw of runnerSetAssignments(text)) {
    const tokens = [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    if (!tokens.some((l) => l.toLowerCase() === 'self-hosted')) {
      continue; // hosted assignment (the pick_runner fallback branch)
    }
    checkSet(tokens, `runner-set assignment ${raw}`);
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
    const selfHosted = runnerSetAssignments(text).filter((raw) =>
      /self-hosted/i.test(raw),
    );
    assert.ok(
      selfHosted.length >= 2,
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
