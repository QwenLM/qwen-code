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
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
// for it.
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

// Expression labels the guard may skip: a genuinely runtime-resolved label
// reads from one of these contexts (update-ecs-runner-qwen.yml fans out over
// `${{ matrix.runner }}`). A `${{ ... }}` label that names NO runtime context
// is a constant in costume — GitHub evaluates `${{ 'ecs-x' }}` to the string
// `ecs-x` — and skipping it would let an invented lane ship, so it fails
// closed instead.
const RUNTIME_CONTEXT =
  /\$\{\{[^}]*\b(matrix|needs|inputs|env|github|vars|secrets|strategy|steps)\s*\./;

const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

// Candidate label-set texts come from two places:
//  - `runs-on:` values (line-anchored so a bash `[ "$X" == "self-hosted" ]`
//    in a run body is not mistaken for a label set; the key match tolerates
//    a quoted key and space before the colon — both valid YAML),
//  - whole-line `VAR='["…"]'` assignments, because ci.yml's pick_runner step
//    assembles the Linux runner set OFF the runs-on line and four jobs
//    consume it through `fromJSON(needs.classify_pr.outputs.ubuntu_runner)`.
//    Without this, mutating that assignment to an invented lane ships green
//    while the repo's main CI path queues forever. This is the one deliberate
//    relaxation of the no-run-body rule, scoped to that exact shape.
function candidateValues(text) {
  const runsOn = [...text.matchAll(/^\s*(["']?)runs-on\1\s*:\s*(.*)$/gm)].map(
    (m) => m[2],
  );
  const assignments = [
    ...text.matchAll(/^\s*[A-Za-z_][A-Za-z0-9_]*='(\[[^\n]*\])'\s*$/gm),
  ].map((m) => m[1]);
  return [...runsOn, ...assignments];
}

// Classifies every candidate value: parsed self-hosted label sets land in
// `sets`, and every spelling naming (or possibly hiding) self-hosted labels
// that this parser cannot read lands in `unreadable` and FAILS the suite —
// never silently in neither. The refusals are keyed on SHAPE, not on an
// enumeration of spellings, because entrances cannot be enumerated out of a
// YAML grammar: any block form (labels on following lines), alias, anchor,
// comment-led value, unbalanced flow sequence, or self-hosted-naming value
// that produced no parsed set is refused. Keeping the repo on single-line
// quoted `runs-on` values is part of the contract; the failure message says
// to inline the labels.
function selfHostedLabelSets(text) {
  const sets = [];
  const unreadable = [];
  for (const value of candidateValues(text)) {
    const trimmed = value.trim();
    // Any block scalar (|, |-, |+, |2, >, >-, …), block sequence (empty
    // value), alias/anchor, or comment-led value: the labels live on lines
    // this parser does not read, so it cannot vouch for them.
    if (trimmed === '' || /^[|>*&#]/.test(trimmed)) {
      unreadable.push(
        `'runs-on: ${trimmed}' (block/alias/comment form — labels this guard cannot read)`,
      );
      continue;
    }
    // A flow sequence opened on this line but not closed on it (multi-line
    // flow): the remaining labels are invisible here.
    if (/\[/.test(value) && !/\]/.test(value)) {
      unreadable.push(`unclosed flow sequence: '${trimmed}'`);
      continue;
    }
    let parsedSelfHosted = false;
    for (const match of value.matchAll(/\[[^[\]]*self-hosted[^[\]]*\]/gi)) {
      const labels = [...match[0].matchAll(/["']{1,2}([^"']+)["']{1,2}/g)].map(
        (m) => m[1],
      );
      if (labels.some((l) => l.toLowerCase() === 'self-hosted')) {
        sets.push({ raw: match[0], labels });
        parsedSelfHosted = true;
      } else {
        // The bracket group names self-hosted but quoted extraction found no
        // labels: the unquoted flow spelling.
        unreadable.push(`unquoted label list: ${match[0]}`);
      }
    }
    if (!parsedSelfHosted && /self-hosted/i.test(value)) {
      // Anything else that names self-hosted without yielding a parsed set —
      // a bare `runs-on: self-hosted`, a partially-quoted list, a spelling
      // this parser has never seen. Fail closed rather than guess.
      unreadable.push(`unrecognized self-hosted spelling: '${trimmed}'`);
    }
  }
  return { sets, unreadable };
}

// Turns one workflow's text into a test plan: the failing tests for every
// unreadable spelling, the lane assertions for every parsed set, and the
// lanes to record as referenced. Pure — no `it()` registration — so the
// fail-closed describe below can execute the planned test bodies directly
// and prove they throw. The main loop maps plans to `it()` one-to-one; the
// `found` accounting also flows through the plan, so deleting that mapping
// starves the "every registered lane is still referenced" assertion instead
// of failing silently.
function laneTestPlan(file, text) {
  const { sets, unreadable } = selfHostedLabelSets(text);
  const tests = [];
  const lanes = [];

  for (const spelling of unreadable) {
    tests.push({
      name: `${file}: guard cannot read a runs-on`,
      run: () => {
        assert.fail(
          `${spelling} — this guard cannot verify the lane, so it fails ` +
            `closed. Inline the labels as a single-line quoted sequence ` +
            `(or extend selfHostedLabelSets).`,
        );
      },
    });
  }

  for (const { raw, labels } of sets) {
    const laneLabels = labels.filter(
      (l) => !PLATFORM_LABELS.has(l.toLowerCase()),
    );
    const dynamic = laneLabels.filter((l) => l.includes('${{'));

    if (dynamic.length > 0) {
      // The skip below vouches only for label sets that are WHOLLY resolved
      // at run time from a real context. A constant expression is not that —
      // GitHub evaluates it to a plain string, so it can smuggle an invented
      // lane — and a static lane written beside a dynamic one is not that
      // either: the static half is checkable and must be checked.
      const opaque = dynamic.filter((l) => !RUNTIME_CONTEXT.test(l));
      const staticResidue = laneLabels.filter((l) => !l.includes('${{'));
      if (opaque.length > 0 || staticResidue.length > 0) {
        const parts = [
          ...opaque.map(
            (l) => `expression label is not a runtime context: ${l}`,
          ),
          ...staticResidue.map(
            (l) => `static lane mixed with a dynamic fan-out: ${l}`,
          ),
        ];
        tests.push({
          name: `${file}: ${raw} mixes checkable labels into a dynamic set`,
          run: () => {
            assert.fail(
              `${parts.join('; ')} — split the static lane onto its own ` +
                `runs-on (or resolve it from a runtime context) so the ` +
                `registry can vouch for it.`,
            );
          },
        });
        continue;
      }
      // Genuine runtime fan-out (e.g. update-ecs-runner-qwen.yml's
      // `${{ matrix.runner }}` over the ecs-update-* hosts): resolves at run
      // time, is not a lane, nothing routes ordinary work to it — skip.
      continue;
    }

    tests.push({
      name: `${file}: ${raw} names exactly one registered lane`,
      run: () => {
        assert.equal(
          laneLabels.length,
          1,
          `expected one lane label beside the platform labels, got [${laneLabels.join(', ')}]`,
        );
        assert.ok(
          REGISTERED_LANES.has(laneLabels[0]),
          `"${laneLabels[0]}" is not a registered lane. Register the label ` +
            `on the runners first, then add it to REGISTERED_LANES in this ` +
            `file. A label no runner carries makes the job queue forever ` +
            `with no error.`,
        );
      },
    });
    for (const lane of laneLabels) {
      lanes.push(lane);
    }
  }

  return { tests, lanes };
}

describe('self-hosted runs-on labels', () => {
  const found = new Map();

  for (const file of workflowFiles) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const { tests, lanes } = laneTestPlan(file, text);
    for (const planned of tests) {
      it(planned.name, planned.run);
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
});

// The fail-closed contract, pinned on synthetic text so it cannot rot: every
// candidate spelling must land in `sets` or in `unreadable` — never silently
// in neither — and the planned test bodies must actually throw. Each refused
// spelling below was verified to slip an invented lane past an earlier
// parser unnoticed.
describe('selfHostedLabelSets fail-closed parsing', () => {
  const parses = [
    [
      `    runs-on: '\${{ x && fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]'') || fromJSON(''["ubuntu-latest"]'') }}'`,
      ['ecs-qwen'],
    ],
    [
      `    runs-on: ['self-hosted', 'linux', 'x64', 'ecs-agent']`,
      ['ecs-agent'],
    ],
    // Key-spelling tolerance: quoted key, and space before the colon.
    [
      `    "runs-on": ['self-hosted', 'linux', 'x64', 'ecs-light']`,
      ['ecs-light'],
    ],
    [`    runs-on : ['self-hosted', 'linux', 'x64', 'ecs-qwen']`, ['ecs-qwen']],
    // The pick_runner assignment shape: the runner set assembled off the
    // runs-on line (ci.yml:183/186) must reach the same validation.
    [
      `            ubuntu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]'`,
      ['ecs-qwen'],
    ],
  ];
  for (const [text, lanes] of parses) {
    it(`parses: ${text.trim().slice(0, 60)}…`, () => {
      const { sets, unreadable } = selfHostedLabelSets(text);
      assert.equal(unreadable.length, 0);
      assert.deepEqual(
        sets.flatMap((s) =>
          s.labels.filter((l) => !PLATFORM_LABELS.has(l.toLowerCase())),
        ),
        lanes,
      );
    });
  }

  // The whole block-form family, generated so a marker cannot quietly drop
  // out of coverage, plus every other demonstrated fail-open entrance.
  const refuses = [
    ...['|', '|-', '|+', '|2', '>', '>-', '>-2'].map((marker) => [
      `block scalar '${marker}'`,
      `    runs-on: ${marker}\n      self-hosted`,
    ]),
    [
      'block sequence',
      `    runs-on:\n      - self-hosted\n      - linux\n      - x64\n      - ecs-invented`,
    ],
    [
      'block scalar with trailing comment',
      `    runs-on: |- # labels below\n      self-hosted`,
    ],
    ['comment-led value', `    runs-on: # see below\n      - self-hosted`],
    ['YAML alias', `    runs-on: *shared-runner`],
    ['YAML anchor', `    runs-on: &shared-runner [self-hosted, ecs-invented]`],
    [
      'unquoted flow sequence',
      `    runs-on: [self-hosted, linux, x64, ecs-invented]`,
    ],
    [
      'multi-line flow sequence',
      `    runs-on: [\n      'self-hosted', 'linux', 'x64', 'ecs-invented']`,
    ],
    ['bare self-hosted', `    runs-on: self-hosted`],
    [
      'partially quoted list',
      `    runs-on: [self-hosted, 'linux', 'x64', ecs-invented]`,
    ],
  ];
  for (const [name, text] of refuses) {
    it(`refuses to skip: ${name}`, () => {
      const { sets, unreadable } = selfHostedLabelSets(text);
      assert.equal(sets.length, 0);
      assert.ok(
        unreadable.length >= 1,
        `the ${name} spelling parsed as neither a label set nor unreadable — ` +
          `an invented lane written this way would ship past a green suite`,
      );
    });
  }

  // Dynamic-label boundaries: a pure runtime fan-out skips, but a constant
  // expression or a static lane hiding beside a dynamic one fails closed.
  it('skips a pure runtime fan-out label set', () => {
    const { tests, lanes } = laneTestPlan(
      'probe.yml',
      `    runs-on: ['self-hosted', 'linux', 'x64', '\${{ matrix.runner }}']`,
    );
    assert.equal(tests.length, 0);
    assert.equal(lanes.length, 0);
  });

  it('fails closed on a static lane mixed into a dynamic set', () => {
    const { tests } = laneTestPlan(
      'probe.yml',
      `    runs-on: ['self-hosted', 'linux', 'x64', 'ecs-invented', '\${{ matrix.runner }}']`,
    );
    assert.equal(tests.length, 1);
    assert.throws(tests[0].run, /static lane mixed with a dynamic fan-out/);
  });

  it('fails closed on a constant expression label', () => {
    const { tests } = laneTestPlan(
      'probe.yml',
      `    runs-on: ['self-hosted', 'linux', 'x64', '\${{ ''ecs-invented'' }}']`,
    );
    assert.equal(tests.length, 1);
    assert.throws(tests[0].run, /not a runtime context/);
  });

  // The registration wiring itself: an unreadable spelling must produce a
  // planned test whose body throws, and an invented lane must produce a
  // planned test whose body throws — so deleting or neutering the
  // registration branch goes red here, not silently fail-open.
  it('plans a throwing test for an unreadable spelling', () => {
    const { tests } = laneTestPlan('probe.yml', `    runs-on: self-hosted`);
    assert.equal(tests.length, 1);
    assert.throws(tests[0].run, /cannot verify the lane/);
  });

  it('plans a throwing test for an invented lane', () => {
    const { tests, lanes } = laneTestPlan(
      'probe.yml',
      `    runs-on: ['self-hosted', 'linux', 'x64', 'ecs-invented']`,
    );
    assert.equal(tests.length, 1);
    assert.throws(tests[0].run, /not a registered lane/);
    assert.deepEqual(lanes, ['ecs-invented']);
  });

  it('plans a throwing test for an invented lane in a runner-set assignment', () => {
    const { tests } = laneTestPlan(
      'probe.yml',
      `            ubuntu_runner='["self-hosted", "linux", "x64", "ecs-invented"]'`,
    );
    assert.equal(tests.length, 1);
    assert.throws(tests[0].run, /not a registered lane/);
  });

  it('plans a passing test for a registered lane', () => {
    const { tests, lanes } = laneTestPlan(
      'probe.yml',
      `    runs-on: ['self-hosted', 'linux', 'x64', 'ecs-qwen']`,
    );
    assert.equal(tests.length, 1);
    tests[0].run();
    assert.deepEqual(lanes, ['ecs-qwen']);
  });
});
