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

// Lane labels the ECS fleet registers. Each of the five Linux hosts carries
// 25 runner registrations, and a host is dedicated to one lane so the pool
// stays assignable at a glance:
//
//   hk-…6t, hk-…6u    all 25   ecs-agent   review / autofix (6–8h budgets)
//   64c, sg, hk-j6cdq      1   ecs-light   seconds-long jobs
//                       2–25   ecs-qwen    CI (90 minute budget)
//
// Separating light from qwen is about head-of-line blocking, not capacity:
// the seconds-long jobs are ~71% of the queue and ~13% of the machine time,
// so they starve behind the long lanes while costing almost nothing to move.
// Three light slots drain a 89-job peak in about seven minutes at their
// ~15-second median.
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

const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

// Reads only `runs-on:` values — every one in this repo is a single line —
// so a bash `[ "$X" == "self-hosted" ]` inside a run body is not mistaken for
// a label set. Matches both spellings a `runs-on` can take: the YAML sequence
// ['self-hosted', 'linux', 'x64', 'ecs-qwen'] and the JSON text inside
// fromJSON('["self-hosted", "linux", "x64", "ecs-qwen"]'), whose quotes are
// doubled by the surrounding single-quoted YAML scalar.
function selfHostedLabelSets(text) {
  const sets = [];
  const runsOnValues = [...text.matchAll(/^\s*runs-on:(.*)$/gm)].map(
    (m) => m[1],
  );
  for (const match of runsOnValues
    .join('\n')
    .matchAll(/\[[^[\]]*self-hosted[^[\]]*\]/gi)) {
    const labels = [...match[0].matchAll(/["']{1,2}([^"']+)["']{1,2}/g)].map(
      (m) => m[1],
    );
    if (labels.some((l) => l.toLowerCase() === 'self-hosted')) {
      sets.push({ raw: match[0], labels });
    }
  }
  return sets;
}

describe('self-hosted runs-on labels', () => {
  const found = new Map();

  for (const file of workflowFiles) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    for (const { raw, labels } of selfHostedLabelSets(text)) {
      const lanes = labels.filter((l) => !PLATFORM_LABELS.has(l.toLowerCase()));

      // A matrix- or input-driven label (update-ecs-runner-qwen.yml fans out
      // over the ecs-update-* hosts) resolves at run time and cannot be
      // checked from the text. Those labels are not lanes — nothing routes
      // ordinary work to them — so skipping keeps the registry to the lanes
      // it can actually vouch for.
      if (lanes.some((l) => l.includes('${{'))) {
        continue;
      }

      it(`${file}: ${raw} names exactly one registered lane`, () => {
        assert.equal(
          lanes.length,
          1,
          `expected one lane label beside the platform labels, got [${lanes.join(', ')}]`,
        );
        assert.ok(
          REGISTERED_LANES.has(lanes[0]),
          `"${lanes[0]}" is not a registered lane. Register the label on the ` +
            `runners first, then add it to REGISTERED_LANES in this file. A ` +
            `label no runner carries makes the job queue forever with no error.`,
        );
      });

      for (const lane of lanes) {
        found.set(lane, (found.get(lane) ?? 0) + 1);
      }
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
