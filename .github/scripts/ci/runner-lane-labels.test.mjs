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
import {
  routingEnvironments,
  runStepBody,
} from './runner-selection-harness.mjs';

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
  // Not part of it either: hk4 is pinned host-wide for release validation
  // and deliberately does not carry ecs-qwen (release.yml:53-58).
  'ecs-qwen-hk4-host',
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

// Seeded into an executed producer's environment for the consumed name. If it
// comes back out of $GITHUB_OUTPUT, the body published what it INHERITED
// rather than what it assigned — which is how an earlier step's $GITHUB_ENV
// write reaches runs-on through a body whose assignment never ran.
const POISONED_RUNNER_SET =
  '["self-hosted", "linux", "x64", "ecs-poisoned-by-harness"]';

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
//
// A line carrying a `${{ }}` is dropped: GitHub substitutes before bash
// parses, so the value assigned is not the text matched here — not even when
// the expression only rides a trailing comment, which `(?:#.*)?$` tolerates.
// The producer path refuses a `${{ }}` body outright; this is the only bar
// that reaches the job-wide accounting for a body no runs-on consumes.
function runnerSetAssignments(text) {
  return [
    ...text.matchAll(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)=(['"])(\[[^\n]*?\])\2\s*(?:#.*)?$/gm,
    ),
  ]
    .filter((m) => !m[0].includes('${{'))
    .map((m) => ({ name: m[1], raw: m[3] }));
}

// The labels a bracketed literal delivers, judged by the authority being
// modelled rather than by a lexer (R13-2). `fromJSON` IS JSON.parse: a
// payload it rejects (single-quoted or mismatched delimiters, a stray extra
// bracket) never reaches the runner at all, and one it parses to a nested
// array reaches it as something other than the flat label set a lexer reads
// out of the same text. Only a flat array of JSON strings vouches; an empty
// "" element stays visible so it fails the set rules the way the
// direct-array spelling does, rather than vanishing from the set.
//
// On failure `tokens` is a double-quoted span scan used for the message
// alone, never for a vouch, so callers can still tell "no quoted labels at
// all" from "quoted labels beside content the guard cannot read" (R11-1 —
// vouching only the quoted subset would certify a label set the guard never
// fully read).
function bracketTokens(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON; the fail-closed return below reports it.
  }
  if (Array.isArray(parsed) && parsed.every((l) => typeof l === 'string')) {
    return { tokens: parsed, parseOk: true };
  }
  return {
    tokens: [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]),
    parseOk: false,
  };
}

// Splits a GitHub expression body on top-level `||` and returns every
// operand that can BE the runs-on value. Quote state honors the
// GitHub-expression `''` escape; parens/brackets nest. Stripping a
// parenthesized value's parens re-exposes top-level operators, so recurse
// until each arm is operator-free.
//
// Which operands can be the value follows from GitHub's own semantics.
// `a || b` yields `b` when `a` is falsy, so a non-terminal `||` part
// contributes only its LAST `&&` operand and its falsy prefixes are
// swallowed by the `||` that follows — those prefixes are conditions (the
// `!= 'true'` comparisons in ci.yml's classify_pr), not labels, and judging
// them would red the accepted routing. The TERMINAL part has no `||` after
// it to swallow anything, and `a && b` yields `a` itself when `a` is falsy,
// so every one of its `&&` operands can reach the runner (R12-1). A
// parenthesized group inherits the terminality of the part it sits in.
function valueArms(body, terminal = true) {
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
  for (const [index, ops] of arms.entries()) {
    const valuePosition = terminal && index === arms.length - 1;
    for (const operand of valuePosition ? ops : ops.slice(-1)) {
      let v = operand.trim();
      while (v.startsWith('(') && v.endsWith(')')) {
        v = v.slice(1, -1).trim();
      }
      if (/\|\||&&/.test(stripQuotesAndParens(v))) {
        out.push(...valueArms(v, valuePosition));
      } else {
        out.push(v);
      }
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

// The closed residual allowlist (R6-1). Every line of a vouched producer
// body that is neither a scannable `name='["…"]'` assignment nor the
// accepted publish must match one of these shapes — each provably unable to
// write the consumed name or run code the guard did not read. The posture
// is the inverse of enumerating dangerous shapes, which fails open every
// time a new write shape is found (eleven review rounds each found one):
// a line that matches no shape here fails the vouch closed instead.
// Assignments carry constant right-hand sides only, the control skeleton
// executes nothing by itself, and the echo reads the name back.
const SAFE_SQ = `'[^']*'`;
const SAFE_BARE = `[A-Za-z0-9_./:%+=@,-]+`;
const SAFE_DQ = `"(?:[^"$\`\\\\]|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\})*"`;
const CASE_HEAD_SHAPE = new RegExp(
  `^\\s*case\\s+(?:${SAFE_SQ}|${SAFE_DQ}|${SAFE_BARE}|` +
    `\\$\\{[A-Za-z_][A-Za-z0-9_]*\\})\\s+in\\s*$`,
);
// An assignment whose TARGET is the runner's own output file rebinds where
// the accepted publish lands: `GITHUB_OUTPUT=/tmp/x` leaves the real output
// file empty, so every consumer silently takes its hosted fallback while
// this guard stays green. $GITHUB_ENV/$GITHUB_PATH need no lookahead — the
// job-wide scan below refuses any body that mentions them at all.
const CONTROL_TARGET = `(?!GITHUB_OUTPUT=)`;
const CASE_ARM_SHAPE = new RegExp(
  `^\\s*[A-Za-z0-9_*?|]+\\)\\s*${CONTROL_TARGET}[A-Za-z_][A-Za-z0-9_]*=` +
    `(?:${SAFE_SQ}|${SAFE_BARE})\\s*;;\\s*$`,
);
const ASSIGN_SHAPE = new RegExp(
  `^\\s*${CONTROL_TARGET}[A-Za-z_][A-Za-z0-9_]*=(?:${SAFE_SQ}|${SAFE_BARE})\\s*(?:#.*)?$`,
);
const SKELETON_SHAPE = /^\s*(?:else|fi|esac)\s*$/;
// `[[ … ]]` conditions cannot run commands; the lookahead bars the four
// sequences inside them that can (command and process substitution).
const IF_HEAD_SHAPE =
  /^\s*(?:if|elif)\s+\[\[\s*(?:(?!\$\(|<\(|>\(|`)[^;\]])+\s*\]\]\s*;\s*then\s*$/;
const BLANK_SHAPE = /^\s*(?:#.*)?$/;

function vouchedResidualLine(line, outName) {
  if (BLANK_SHAPE.test(line)) {
    return true;
  }
  if (SKELETON_SHAPE.test(line)) {
    return true;
  }
  if (CASE_HEAD_SHAPE.test(line)) {
    return true;
  }
  if (CASE_ARM_SHAPE.test(line)) {
    return true;
  }
  if (IF_HEAD_SHAPE.test(line)) {
    return true;
  }
  if (ASSIGN_SHAPE.test(line)) {
    return true;
  }
  // A read-only echo of the consumed name (the live pick_runner logs its
  // pick): content is literal text plus pure reads of the name.
  return new RegExp(
    `^\\s*echo\\s+"(?:[^"$\`\\\\]|\\$\\{${outName}\\}|` +
      `\\$${outName}(?![A-Za-z0-9_]))*"\\s*$`,
  ).test(line);
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
            // set), a needs-output reference whose producer chain passes
            // the closed allowlist in vouchProducer, or a matrix./env.
            // reference resolved to its in-file value. Anything else —
            // format(), toJSON(), a reference whose producer the guard
            // cannot read end to end — fails closed.
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
                const { tokens, parseOk } = bracketTokens(inner);
                if (tokens.length === 0 && inner.slice(1, -1).trim() !== '') {
                  problem(
                    `${file}: ${origin} embeds an unquoted array`,
                    `${inner} has no JSON-quoted labels the guard can read.`,
                  );
                  continue;
                }
                if (!parseOk) {
                  problem(
                    `${file}: ${origin} embeds unquoted content the guard ` +
                      `cannot judge`,
                    `${inner} mixes quoted labels with unquoted content — ` +
                      `vouching only the quoted subset would certify a ` +
                      `label set the guard never fully read.`,
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
                const assemblies = vouchProducer(producerJob, outName, origin);
                if (assemblies === null) {
                  continue;
                }
                for (const a of assemblies) {
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
                    const { tokens, parseOk } = bracketTokens(String(v));
                    if (parseOk) {
                      checkSet(tokens, `${origin} (${operand} = ${v})`);
                    } else {
                      problem(
                        `${file}: ${origin} embeds unquoted content the ` +
                          `guard cannot judge`,
                        `'${operand}' resolves to '${v}', which mixes ` +
                          `quoted labels with unquoted content the guard ` +
                          `cannot read.`,
                      );
                    }
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
    const { tokens, parseOk } = bracketTokens(a.raw);
    if (parseOk) {
      checkSet(tokens, `runner-set assignment ${a.raw}${why}`);
    } else {
      problem(
        `${file}: runner-set assignment ${a.raw}${why} embeds unquoted ` +
          `content the guard cannot judge`,
        `'${a.raw}' mixes quoted labels with unquoted content — vouching ` +
          `only the quoted subset would certify a label set the guard ` +
          `never fully read.`,
      );
    }
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
  // not a producer.
  const jobAssemblies = new Map();
  const assembliesByStep = new Map();
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    const assemblies = [];
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (typeof step?.run !== 'string') {
        continue;
      }
      const stepAssemblies = runnerSetAssignments(step.run);
      assembliesByStep.set(step, stepAssemblies);
      assemblies.push(...stepAssemblies);
    }
    jobAssemblies.set(jobName, assemblies);
  }

  // The consumer vouch, a closed chain: the producer of a consumed output
  // is vouched only when its WHOLE chain is readable end to end, and every
  // other shape fails closed. The posture is the inverse of enumerating
  // dangerous shell shapes — round after round found a write shape the
  // enumeration missed (R6-1) — so anything the chain cannot name safe
  // fails closed by default:
  //
  //  - the job's outputs mapping forwards the consumed name from exactly
  //    `${{ steps.<id>.outputs.<name> }}` — any other value there (a
  //    literal array, a redirect to another output, nothing) serves a
  //    value the guard never read;
  //  - that one step holds at least one scannable `name='["…"]'` literal
  //    and the publish `echo "name=${name}" >> "$GITHUB_OUTPUT"`; GitHub
  //    runs each step in a fresh shell, so a literal in another step
  //    cannot feed the publish;
  //  - the step resolves to bash (the shapes this guard vouches are bash
  //    shapes), the job runs in no container, and no env scope visible to
  //    it — step, job or workflow — binds the name or a
  //    BASH_ENV/ENV/BASH_FUNC_* startup key;
  //  - every step of the job that runs BEFORE it is a `run:` step this guard
  //    can read, and none writes $GITHUB_ENV/$GITHUB_PATH or dereferences a
  //    constructed name — a sibling plant feeds a later step's environment or
  //    command lookup without appearing in the producer step at all. A job
  //    runs its steps in order, so a later one cannot reach back;
  //  - every other line of the body matches the closed residual allowlist
  //    (vouchedResidualLine) — shapes that cannot write the name or run
  //    code the guard did not read;
  //  - nothing else in the step mentions the name except pure
  //    `$name`/`${name}` reads — any other mention is a write the scan
  //    cannot read;
  //  - and last, the body is EXECUTED over the whole routing input matrix and
  //    every value it publishes is judged. Everything above reads the file's
  //    text; bash quote removal and GitHub's `${{ }}` substitution mean the
  //    text can vouch a value the step never actually publishes.
  //
  // Returns the scannable assemblies that feed the output, or null after
  // recording why the chain cannot be vouched.
  function vouchProducer(producerJob, outName, origin) {
    const unreadable = (message) => {
      problem(
        `${file}: ${origin} consumes a runner set with an unreadable write`,
        message,
      );
      return null;
    };
    const noProducer = (message) => {
      problem(
        `${file}: ${origin} consumes a runner set with no checkable producer`,
        message,
      );
      return null;
    };
    const job = doc?.jobs?.[producerJob];
    if (!job || typeof job !== 'object') {
      return noProducer(
        `'${producerJob}' is not a job in this file, so the producer of ` +
          `'${outName}' cannot be checked.`,
      );
    }
    // Hop 1 — the outputs mapping: GitHub serves needs.<job>.outputs.<name>
    // from exactly this value.
    const mapping = job.outputs?.[outName];
    const forward =
      typeof mapping === 'string'
        ? mapping.match(
            new RegExp(
              `^\\$\\{\\{\\s*steps\\.([A-Za-z0-9_-]+)\\.outputs\\.${outName}\\s*\\}\\}$`,
            ),
          )
        : null;
    if (!forward) {
      return noProducer(
        mapping === undefined
          ? `job '${producerJob}' publishes no '${outName}' output — the ` +
              `consumer reads a value with no producer to check.`
          : `job '${producerJob}' publishes '${outName}' as '${mapping}' ` +
              `— an unverifiable hop; only ` +
              `\${{ steps.<id>.outputs.${outName} }} forwards a value the ` +
              `guard can trace to a scannable assembly.`,
      );
    }
    // Hop 2 — the one step the mapping names. Two steps sharing the id leave
    // the choice to `.find()`, which is this guard's assumption rather than
    // GitHub's resolution, so a duplicate fails closed instead (R6-1).
    const stepId = forward[1];
    const jobSteps = Array.isArray(job.steps) ? job.steps : [];
    const named = jobSteps.filter(
      (s) => s && typeof s === 'object' && s.id === stepId,
    );
    if (named.length > 1) {
      return unreadable(
        `job '${producerJob}' has ${named.length} steps with id '` +
          `${stepId}' — which one publishes '${outName}' is not readable ` +
          `here, so the value that reaches runs-on is not either.`,
      );
    }
    const step = named[0];
    if (!step || typeof step.run !== 'string') {
      return noProducer(
        `job '${producerJob}' has no run step with id '${stepId}' — the ` +
          `consumed output cannot come from a scannable assembly.`,
      );
    }
    // A container binds environment this file cannot read: `docker create`
    // options and the image's own ENV both reach the step, so enumerating
    // `container.env` beside step/job/workflow would vouch a chain whose
    // environment it only partly saw (R6-1). Refuse the container outright —
    // classify_pr has none, so the live vouch costs nothing.
    if (job.container !== undefined) {
      return unreadable(
        `job '${producerJob}' runs in a container — its options and image ` +
          `can bind '${outName}' or a bash startup key outside every scope ` +
          `this guard reads.`,
      );
    }
    // Env scopes visible to the step. A binding of the consumed name lets
    // the publish expand a value no scannable literal assigns, and a
    // BASH_ENV/ENV/BASH_FUNC_* binding is executed by bash at startup,
    // before the body the guard read (R6-1 h/l).
    const envScopes = [step.env, job.env, doc?.env];
    for (const scope of envScopes) {
      if (scope && typeof scope === 'object' && outName in scope) {
        return unreadable(
          `an env scope binds '${outName}', so the publish in step ` +
            `'${stepId}' can expand a value no scannable literal assigns.`,
        );
      }
    }
    for (const scope of envScopes) {
      if (!scope || typeof scope !== 'object') {
        continue;
      }
      const startupKey = Object.keys(scope).find((key) =>
        /^(BASH_ENV|ENV)$|^BASH_FUNC_/.test(key),
      );
      if (startupKey !== undefined) {
        return unreadable(
          `an env scope binds '${startupKey}', which bash executes at ` +
            `startup — code this guard never read runs before step ` +
            `'${stepId}'.`,
        );
      }
    }
    // The resolved shell must be bash: the shapes this guard vouches are
    // bash shapes, and any other shell executes a body the allowlist
    // cannot read (R6-1 k).
    const shell = String(
      step.shell ??
        job?.defaults?.run?.shell ??
        doc?.defaults?.run?.shell ??
        'bash',
    ).trim();
    if (shell !== 'bash') {
      return unreadable(
        `step '${stepId}' of job '${producerJob}' runs under shell ` +
          `'${shell}' — the closed chain vouches bash bodies only.`,
      );
    }
    // A $GITHUB_ENV write by an EARLIER step of the job plants a binding the
    // publish expands when no scannable assignment ran (a dead branch), and
    // a $GITHUB_PATH append shims command lookup — neither write appears in
    // the producer step itself (R6-1 e/g). A dereference or eval primitive
    // lets a body build the sink's name (`v='GITHUB'; v+=_ENV; … >> "${!v}"`)
    // so that literal spelling never appears.
    //
    // Only earlier steps can reach it: a job runs its steps in order, so a
    // later one cannot plant this step's environment or command lookup.
    // Scoping the scan to them is what keeps ci.yml's classify_pr vouched —
    // it checks the trusted CI classifier out with actions/checkout AFTER
    // pick_runner has published, and refusing that action reddened the
    // repo's own main CI lane over a step that cannot influence the value.
    //
    // This substring posture is inherently incomplete against deliberate
    // obfuscation. The closures that do not depend on recognizing a spelling
    // are refusing a `uses:` step below — opaque action code — refusing a
    // container above, and the executed body's own refusals in hop 4.
    const SIBLING_WRITE =
      /GITHUB_ENV|GITHUB_PATH|\$\{!|(^|\s|;)(?:eval|declare)\s/;
    for (const sibling of jobSteps.slice(0, jobSteps.indexOf(step))) {
      if (typeof sibling?.uses === 'string') {
        return unreadable(
          `a step of job '${producerJob}' runs the action ` +
            `'${sibling.uses}' — opaque code this guard cannot read can ` +
            `plant the value the publish in '${stepId}' expands.`,
        );
      }
      if (typeof sibling?.run === 'string' && SIBLING_WRITE.test(sibling.run)) {
        return unreadable(
          `a step of job '${producerJob}' writes $GITHUB_ENV/$GITHUB_PATH ` +
            `or dereferences a constructed name, feeding a later step's ` +
            `environment or command lookup — the value the publish in ` +
            `'${stepId}' expands is one this guard never read.`,
        );
      }
    }
    // Hop 3 — the step body, judged as a closed chain: the scannable
    // literals and the accepted publish are the only value writes, and
    // every other line must match the closed residual allowlist. A
    // backslash-continued line ends in a backslash outside any comment,
    // and no vouched shape does — a continuation merges two lines, so
    // neither line alone is what bash parses (R6-1 f).
    const run = step.run;
    // A `${{ }}` anywhere in the body means what follows is not the text
    // bash parses: GitHub substitutes the expression into the script first.
    // Both the assembly scan and the residual allowlist read the FILE, so
    // neither can vouch what actually runs (R6-1). Scoped to the body and
    // never to env values — ci.yml keeps all five of pick_runner's
    // expressions in step `env:`, where substitution is the whole point.
    if (run.includes('${{')) {
      return unreadable(
        `step '${stepId}' of job '${producerJob}' carries a \${{ }} ` +
          `expression in its body — GitHub substitutes it into the script ` +
          `before bash parses it, so the text this guard read is not the ` +
          `text that runs.`,
      );
    }
    const lines = run.split('\n');
    const acceptedPublish = new RegExp(
      `^\\s*echo\\s+"${outName}=\\$\\{?${outName}\\}?"\\s*>>\\s*"?\\$\\{?GITHUB_OUTPUT\\}?"?\\s*$`,
    );
    const assemblies = (assembliesByStep.get(step) ?? []).filter(
      (a) => a.name === outName,
    );
    if (assemblies.length === 0) {
      return noProducer(
        `step '${stepId}' of job '${producerJob}' assigns '${outName}' in ` +
          `no whole-line ${outName}='["…"]' shape the assembly scan can ` +
          `read.`,
      );
    }
    if (!lines.some((l) => acceptedPublish.test(l))) {
      return unreadable(
        `step '${stepId}' of job '${producerJob}' never publishes ` +
          `'${outName}' through echo "${outName}=\${${outName}}" >> ` +
          `"$GITHUB_OUTPUT" — the value that reached the output is one ` +
          `this guard never read.`,
      );
    }
    const residualLines = lines.filter(
      (l) =>
        !runnerSetAssignments(l).some((a) => a.name === outName) &&
        !acceptedPublish.test(l),
    );
    for (const line of residualLines) {
      if (!vouchedResidualLine(line, outName)) {
        return unreadable(
          `step '${stepId}' of job '${producerJob}' carries a line the ` +
            `closed residual allowlist cannot vouch ('${line.trim()}') — ` +
            `any content beside the scannable literals, the accepted ` +
            `publish, and read-only control shapes can write ` +
            `'${outName}' or run code this guard never read.`,
        );
      }
    }
    const scrubbed = residualLines
      .join('\n')
      .replace(new RegExp(`\\$\\{${outName}\\}`, 'g'), ' ')
      .replace(new RegExp(`\\$${outName}(?![A-Za-z0-9_])`, 'g'), ' ');
    if (
      new RegExp(`(^|[^A-Za-z0-9_])${outName}($|[^A-Za-z0-9_])`, 'm').test(
        scrubbed,
      )
    ) {
      return unreadable(
        `step '${stepId}' also touches '${outName}' in a shape the scan ` +
          `cannot read (a read -r / mapfile / for target, an indexed or ` +
          `keyword-prefixed assignment, unset, a \${${outName}:=word} ` +
          `default) — a scannable literal beside it cannot vouch for what ` +
          `actually reached the output.`,
      );
    }
    // Hop 4 — execute the body and read what it actually published. The
    // allowlist above judges the file's TEXT, but bash removes quotes before
    // the value reaches $GITHUB_OUTPUT, so the text can vouch a value the
    // step never publishes (R6-1). The two vouches are complementary, not
    // alternatives: execution cannot see a line that delegates to code this
    // file cannot read (`source ./evil.sh` is simply absent here), which is
    // what the allowlist refuses, and the allowlist cannot see what bash
    // makes of the text it did vouch, which is what execution refuses.
    //
    // The consumed name is seeded with a value no runner carries; if that
    // comes back out, the body published what it INHERITED rather than what
    // it assigned — how a dead-branch body lets an earlier $GITHUB_ENV plant
    // reach runs-on.
    const scannedLiterals = new Set(assemblies.map((a) => a.raw));
    const published = new Set();
    for (const env of routingEnvironments()) {
      const result = runStepBody(run, {
        ...env,
        [outName]: POISONED_RUNNER_SET,
      });
      if (result.status !== 0) {
        return unreadable(
          `step '${stepId}' of job '${producerJob}' exits ` +
            `${result.status} when executed (` +
            `${result.stderr.split('\n')[0] || 'no stderr'}) — a body that ` +
            `does not run publishes nothing this guard can vouch for.`,
        );
      }
      const value = result.outputs.get(outName);
      if (value === POISONED_RUNNER_SET) {
        return unreadable(
          `step '${stepId}' of job '${producerJob}' publishes ` +
            `'${outName}' from its environment instead of assigning it — ` +
            `an earlier write, not this body, chooses what reaches runs-on.`,
        );
      }
      if (value === undefined) {
        return unreadable(
          `step '${stepId}' of job '${producerJob}' publishes no ` +
            `'${outName}' to $GITHUB_OUTPUT when executed — every consumer ` +
            `silently takes its hosted fallback.`,
        );
      }
      published.add(value);
    }
    // A published value the assembly scan already read is judged through the
    // assemblies returned below; only a value bash delivered that the file
    // text does not show — quote removal, concatenation — is judged here, so
    // nothing is booked twice and nothing is skipped.
    for (const value of published) {
      if (scannedLiterals.has(value)) {
        continue;
      }
      const { tokens, parseOk } = bracketTokens(value);
      if (!parseOk) {
        return unreadable(
          `step '${stepId}' of job '${producerJob}' published '${value}', ` +
            `which is not a flat JSON array of labels — bash delivered ` +
            `something fromJSON cannot turn into a runner set, whatever the ` +
            `file text reads as.`,
        );
      }
      checkSet(tokens, `${origin} → executed publish ${value}`);
    }
    return assemblies;
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
      const { tokens, parseOk } = bracketTokens(a.raw);
      if (!parseOk || tokens.some((l) => l.toLowerCase() === 'self-hosted')) {
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

  // R12-1: the TERMINAL || part has no following || to swallow a falsy
  // prefix, and GitHub's `a && b` yields `a` itself when `a` is falsy — so
  // every && operand there can BE the runs-on value and is judged like any
  // other arm. Earlier parts keep discarding their condition operands.
  it('catches an empty-string prefix in a terminal && chain', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(`'\${{ "" && fromJSON(''["ubuntu-latest"]'') }}'`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /single non-hosted label/);
  });

  it('catches an unjudgeable prefix in a terminal && chain', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ needs.preflight.outputs.go && fromJSON(''["self-hosted", "linux", "x64", "ecs-light"]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unresolvable expression/);
  });

  // A parenthesized group inherits the terminality of the part it sits in:
  // in a NON-terminal part only its last operand can be the value, so the
  // condition operands inside it stay unjudged. Passing terminality down is
  // what keeps this green — always recursing as terminal reds it.
  it("keeps a non-terminal paren group's condition operands unjudged", () => {
    const plan = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ x && (''ubuntu-latest'' || "" && ''ubuntu-latest'') || ''ubuntu-latest'' }}'`,
      ),
    );
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.lanes, []);
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
  // The one producer chain vouchProducer accepts: the outputs mapping
  // forwards the name from the named step, and that step holds scannable
  // literals plus the exact publish. The consumer pins below mutate one
  // link of this chain at a time.
  const producerStep = (lines) =>
    `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
    `    steps:\n      - id: 'pick_runner'\n        run: |-\n` +
    lines.map((l) => `          ${l}\n`).join('');
  const literal = `ubuntu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]'`;
  const publish = `echo "ubuntu_runner=\${ubuntu_runner}" >> "\${GITHUB_OUTPUT}"`;

  it('accepts the consumer shape when its producer assignment is present', () => {
    const plan = laneTestPlan(
      'probe.yml',
      wrap(consumer, producerStep([literal, publish])),
    );
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.lanes, ['ecs-qwen']);
  });

  // (iv) The scan judges a double-quoted assignment as its pre-shell JSON
  // text, but bash quote removal delivers `[self-hosted, linux, x64,
  // ecs-qwen]` — one string fromJSON rejects, so the consumer's fromJSON
  // throws and the job never routes. The executed vouch reads what bash
  // delivered instead of what the file reads as.
  it('refuses a double-quoted producer assignment bash delivers unquoted', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([
          `ubuntu_runner="["self-hosted", "linux", "x64", "ecs-qwen"]"`,
          publish,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
    assert.match(blob(problems[0]), /not a flat JSON array/);
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
        producerStep([
          `ubuntu_runner="["self-hosted", "linux", "x64", "ecs-invented"]"`,
          publish,
        ]),
      ),
    );
    // The executed vouch refuses the spelling bash cannot deliver as JSON,
    // and the job-wide assembly accounting still names the invented lane.
    assert.equal(problems.length, 2);
    assert.match(blob(problems[0]), /not a flat JSON array/);
    assert.match(blob(problems[1]), /not a registered lane/);
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
        producerStep([
          literal,
          `ubuntu_runner="$(jq -r .runner config.json)"`,
          publish,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable write/);
  });

  // R9: the vouch is anchored on the $GITHUB_OUTPUT publish write — no
  // value reaches the consumer except through it, so a publish from a
  // different variable, or any reassignment shape beside the accepted
  // wiring, fails closed.
  it('fails closed when the consumed output is written from a differently-named variable', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([
          literal,
          `echo "ubuntu_runner=$other_var" >> "\${GITHUB_OUTPUT}"`,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable write/);
  });

  it('fails closed when the consumed name is reassigned via export', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([
          literal,
          `export ubuntu_runner='["self-hosted", "linux", "x64", "ecs-invented"]'`,
          publish,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable write/);
  });

  // R10: the vouch is a closed allowlist over the whole chain — every link
  // the shell-shape enumeration missed fails closed on its own pin.
  it('fails closed when the consumed name is overwritten by read', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([literal, `read -r ubuntu_runner < payload`, publish]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the outputs mapping serves a value the guard never read', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
          `    steps:\n      - id: 'pick_runner'\n        run: |-\n` +
          `          ${literal}\n` +
          `          ${publish}\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unverifiable/);
  });

  it('fails closed when the publish command word is rebound', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  PAYLOAD: 'ubuntu_runner=["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
        wrap(
          consumer,
          producerStep([literal, `echo() { printenv PAYLOAD; }`, publish]),
        ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the literal and the publish sit in different steps', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  ubuntu_runner: '["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
        wrap(
          consumer,
          `    outputs:\n      ubuntu_runner: '\${{ steps.lit.outputs.ubuntu_runner }}'\n` +
            `    steps:\n      - id: 'lit'\n        run: |-\n          ${literal}\n` +
            `      - id: 'pub'\n        run: |-\n          ${publish}\n`,
        ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when an env scope binds the consumed name', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  ubuntu_runner: '["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
        wrap(consumer, producerStep([literal, publish])),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the producer step sources another script', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(consumer, producerStep([literal, `source ./pick.sh`, publish])),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the named step has no scannable literal', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(consumer, producerStep([publish])),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('fails closed when the named step never publishes the output', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(consumer, producerStep([literal])),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the consumed output names no job in the file', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON(needs.ghost.outputs.ubuntu_runner || ''["ubuntu-latest"]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('fails closed when a scannable literal in another step cannot feed the publish', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '\${{ steps.pub.outputs.ubuntu_runner }}'\n` +
          `    steps:\n      - id: 'lit'\n        run: |-\n          ${literal}\n` +
          `      - id: 'pub'\n        run: |-\n          ${publish}\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  it('fails closed when the outputs mapping names a step that does not exist', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '\${{ steps.ghost.outputs.ubuntu_runner }}'\n` +
          `    steps:\n      - id: 'pick_runner'\n        run: |-\n` +
          `          ${literal}\n` +
          `          ${publish}\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /no checkable producer/);
  });

  // R6-1 (round 12): the producer vouch is a CLOSED chain — a line, env
  // binding, sibling write, or shell the chain cannot name safe fails it
  // closed, so a write shape the guard does not model cannot deliver a
  // value it never read. One pin per demonstrated entrance; each table
  // entry adds one unvouched line beside the otherwise-vouched chain.
  const residualEntrances = [
    [
      'a constructed-identifier write',
      `printf -v "ubuntu""_runner" '["self-hosted", "linux", "x64", "ecs-invented"]'`,
    ],
    ['an env-fed eval', `eval "$PAYLOAD"`],
    [
      'a second $GITHUB_OUTPUT write',
      `cat payload.json >> "\${GITHUB_OUTPUT}"`,
    ],
    [
      'a constructed-key $GITHUB_OUTPUT write',
      `key='ubuntu_runner'; echo "\${key}=[evil]" >> "\${GITHUB_OUTPUT}"`,
    ],
    ['a mid-line source', `true; source ./evil.sh`],
    ['a mid-line dotted source', `true; . ./evil.sh`],
    ['a disabled echo builtin', `enable -n echo`],
    ['a delegated child shell (bash)', `bash ./evil.sh`],
    ['a delegated child shell (path exec)', `./evil.sh`],
    ['a delegated child shell (env)', `env bash`],
    ['a trap rebind of the publish', `trap 'ubuntu_runner=evil' EXIT`],
    ['an alias rebind of echo', `alias echo='echo evil'`],
    ['a shopt enabling alias expansion', `shopt -s expand_aliases`],
    // Rebinding the runner's own output file leaves it empty, so every
    // consumer silently takes its hosted fallback (R6-1).
    ['a $GITHUB_OUTPUT rebind', `GITHUB_OUTPUT=/tmp/redirect`],
    [
      'a $GITHUB_OUTPUT rebind as a case arm',
      `x) GITHUB_OUTPUT=/tmp/redirect ;;`,
    ],
  ];
  for (const [name, extraLine] of residualEntrances) {
    it(`fails closed on ${name}`, () => {
      const { problems } = laneTestPlan(
        'probe.yml',
        wrap(consumer, producerStep([literal, extraLine, publish])),
      );
      assert.equal(problems.length, 1);
      assert.match(blob(problems[0]), /unreadable/);
    });
  }

  // The scannable literal sits in a dead branch: without the sibling
  // plant the body vouches clean, so only the job-wide $GITHUB_ENV/
  // $GITHUB_PATH scan can catch this class.
  const siblingPlant = (plantLine) =>
    `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
    `    steps:\n      - run: |-\n          ${plantLine}\n` +
    `      - id: 'pick_runner'\n        run: |-\n` +
    `          if [[ "\${EVENT_NAME}" == "never" ]]; then\n` +
    `            ${literal}\n` +
    `          fi\n` +
    `          ${publish}\n`;

  it('fails closed when a sibling step plants $GITHUB_ENV', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        siblingPlant(
          `echo 'ubuntu_runner=["self-hosted", "linux", "x64", "ecs-invented"]' >> "\${GITHUB_ENV}"`,
        ),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when a sibling step appends to $GITHUB_PATH', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(consumer, siblingPlant(`echo "/shims" >> "\${GITHUB_PATH}"`)),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed on a backslash-continued assignment name', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([
          literal,
          'ubuntu\\',
          `_runner="$(cat payload)"`,
          publish,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when a workflow env scope binds BASH_ENV', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  BASH_ENV: '/tmp/startup.sh'\n` +
        wrap(consumer, producerStep([literal, publish])),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when a job env scope binds a BASH_FUNC_ key', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    env:\n      BASH_FUNC_echo%%: '() { cat payload; }'\n` +
          producerStep([literal, publish]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the producer step runs under a non-bash shell', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
          `    steps:\n      - id: 'pick_runner'\n        shell: 'python'\n` +
          `        run: |-\n          ${literal}\n          ${publish}\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when workflow defaults resolve the producer to sh', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `defaults:\n  run:\n    shell: 'sh'\n` +
        wrap(consumer, producerStep([literal, publish])),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when a sibling step is an action this guard cannot read', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
          `    steps:\n      - uses: actions/github-script@v7\n` +
          `      - id: 'pick_runner'\n        run: |-\n` +
          `          ${literal}\n          ${publish}\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  // The sibling scan looks for a literal spelling; a body that builds the
  // sink's name out of pieces never shows one.
  it('fails closed when a sibling builds the sink name by dereference', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        siblingPlant(
          `v='GITHUB'; v+=_ENV; echo 'ubuntu_runner=[evil]' >> "\${!v}"`,
        ),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  it('fails closed when the container env binds the consumed name', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    container:\n      image: 'node:22'\n      env:\n` +
          `        ubuntu_runner: '["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
          producerStep([literal, publish]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  // `container.env` is only the part of a container's environment the file
  // happens to record: `docker create` options and the image's own ENV bind
  // the name too and neither is readable here, so any container fails the
  // vouch (R6-1).
  it('fails closed when the producer job runs in a container', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    container:\n      image: 'node:22'\n` +
          `      options: '--env ubuntu_runner=["self-hosted", "linux", "x64", "ecs-invented"]'\n` +
          producerStep([literal, publish]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
  });

  // R11-1: a bracketed literal carrying unquoted content beside its quoted
  // labels is not vouched as its quoted subset — the guard would certify a
  // label set it never fully read.
  it('fails closed when the producer literal embeds unquoted content', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([
          `ubuntu_runner='["self-hosted", "linux", "x64", "ecs-qwen", 123]'`,
          publish,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
  });

  it('fails closed when an env operand resolves to mixed unquoted content', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  RUNNER_SET: '["self-hosted", "linux", "x64", "ecs-qwen", 123]'\n` +
        wrap(`'\${{ fromJSON(env.RUNNER_SET || ''["ubuntu-latest"]'') }}'`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
  });

  it('fails closed when a standalone assembly embeds unquoted content', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n` +
        `      - run: |-\n` +
        `          extra_labels='["ecs-qwen", 123]'\n`,
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
  });

  it('fails closed when a fromJSON arm embeds unquoted content', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen", 123]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
  });

  // R13-2: the payload is judged by the authority being modelled, because
  // `fromJSON` IS JSON.parse. A lexer that erased brackets and paired any
  // quote with any quote vouched each shape below as the flat set it read
  // out of the text — while JSON.parse either throws, so GitHub's evaluator
  // kills the job at start, or yields a nested value that is not that set.
  // Each entrance reads the payload: the fromJSON literal arm, a resolved
  // env. operand, and the standalone assembly scan.
  it('fails closed on a nested fromJSON literal', () => {
    const { problems, lanes } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON(''["self-hosted", ["linux", "x64", "ecs-qwen"]]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
    assert.deepEqual(lanes, []);
  });

  it('fails closed on an unbalanced fromJSON literal', () => {
    const { problems, lanes } = laneTestPlan(
      'probe.yml',
      wrap(
        `'\${{ fromJSON(''["self-hosted", "linux", "x64", "ecs-qwen"]]'') }}'`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
    assert.deepEqual(lanes, []);
  });

  it('fails closed when an env operand resolves to a nested array', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `env:\n  RUNNER_SET: '["self-hosted", ["linux", "x64", "ecs-qwen"]]'\n` +
        wrap(`'\${{ fromJSON(env.RUNNER_SET) }}'`),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
  });

  it('fails closed when a standalone assembly is a nested array', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n` +
        `      - run: |-\n` +
        `          ubuntu_runner='["self-hosted", ["linux", "x64", "ecs-qwen"]]'\n`,
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unquoted content/);
  });

  it('fails closed on a payload whose delimiters are not JSON', () => {
    // Expression-level '' quoting leaves JSON single-quote delimiters, and a
    // mismatched pair leaves a lone single quote. JSON.parse rejects both, so
    // GitHub's evaluator raises and the runs-on this vouched can never run.
    for (const runsOn of [
      `'\${{ fromJSON(''[''''self-hosted'''', ''''linux'''', ''''x64'''', ''''ecs-light'''']'') }}'`,
      `'\${{ fromJSON(''["self-hosted", "linux", "x64", ''''ecs-qwen"]'') }}'`,
    ]) {
      const { problems, lanes } = laneTestPlan('probe.yml', wrap(runsOn));
      assert.equal(problems.length, 1);
      assert.deepEqual(lanes, []);
    }
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

  // R6-1's entrances, one pin per entrance. Every one of these vouched green
  // at the commit that closed round 13's four seams, and each reds again when
  // its own clause is removed.
  const duplicateIdProducer = (secondLiteral) =>
    `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
    `    steps:\n      - id: 'pick_runner'\n        run: |-\n` +
    `          ${literal}\n          ${publish}\n` +
    `      - id: 'pick_runner'\n        run: |-\n` +
    `          ${secondLiteral}\n          ${publish}\n`;

  // (i) An expression interpolated into the body. GitHub substitutes it
  // before bash parses, so a pull-request title can close the quote and
  // assign the consumed name itself — while the file text the allowlist read
  // shows an ordinary `if`.
  it('fails closed on an expression interpolated into the producer body', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([
          `if [[ '\${{ github.event.pull_request.title }}' == 'a' ]]; then`,
          `  ${literal}`,
          'fi',
          publish,
        ]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
    assert.match(blob(problems[0]), /substitutes it into the script/);
  });

  // (ii) A body whose only assignment sits in a branch the matrix never takes
  // publishes whatever its environment held. That is the channel a sibling's
  // $GITHUB_ENV plant reaches runs-on through, and it needs no sibling to
  // demonstrate: the poisoned seed is what comes back out.
  it('fails closed when the producer publishes an inherited value', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
          `    steps:\n      - id: 'pick_runner'\n        run: |-\n` +
          `          if [[ "\${EVENT_NAME}" == "never" ]]; then\n` +
          `            ${literal}\n` +
          `          fi\n` +
          `          ${publish}\n`,
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
    assert.match(blob(problems[0]), /from its environment/);
  });

  // (iii) A `${{ }}` riding an assembly line's trailing comment. The assembly
  // scan tolerates the comment and the residual filter drops the line before
  // the allowlist ever sees it, so this vouched green — and the trigger is
  // idiomatic rather than adversarial.
  it('fails closed on an expression riding an assembly line comment', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        producerStep([`${literal} # \${{ github.event.issue.body }}`, publish]),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
    assert.match(blob(problems[0]), /substitutes it into the script/);
  });

  // (v) Two steps sharing the producer id. `.find()` reads the first and
  // calls it the producer; which one GitHub resolves is not this guard's to
  // assume. The second step carries a REGISTERED lane so the pin isolates the
  // duplicate — an invented one would add a second problem from the job-wide
  // assembly accounting and measure nothing about the id.
  it('fails closed when two steps share the producer id', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        duplicateIdProducer(
          `ubuntu_runner='["self-hosted", "linux", "x64", "ecs-light"]'`,
        ),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(blob(problems[0]), /unreadable/);
    assert.match(blob(problems[0]), /2 steps with id/);
  });

  // The Required check this round opened with. ci.yml's classify_pr checks the
  // trusted CI classifier out AFTER pick_runner has published, and a job runs
  // its steps in order, so a later step cannot plant this one's environment.
  // Refusing it reddened the repo's own main CI lane over a step that cannot
  // influence the value.
  it('vouches a producer whose opaque action step runs after it', () => {
    const { problems } = laneTestPlan(
      'probe.yml',
      wrap(
        consumer,
        `    outputs:\n      ubuntu_runner: '\${{ steps.pick_runner.outputs.ubuntu_runner }}'\n` +
          `    steps:\n      - id: 'pick_runner'\n        run: |-\n` +
          `          ${literal}\n          ${publish}\n` +
          `      - uses: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10'\n`,
      ),
    );
    assert.deepEqual(problems, []);
  });

  // Hop 4's own refusals. Each fixture passes the whole static chain above —
  // the allowlist vouches every residual line — so only executing the body
  // can see that it does not deliver a readable value.
  const executedRefusals = [
    [
      'exits non-zero when executed',
      [literal, publish, `if [[ "\${EVENT_NAME}" == "never" ]]; then`],
      /when executed/,
    ],
    [
      'never reaches its publish',
      [
        `if [[ "\${EVENT_NAME}" == "never" ]]; then`,
        `  ${literal}`,
        `  ${publish}`,
        'fi',
      ],
      /publishes no/,
    ],
  ];
  for (const [name, body, refusal] of executedRefusals) {
    it(`fails closed when the executed producer ${name}`, () => {
      const { problems } = laneTestPlan(
        'probe.yml',
        wrap(consumer, producerStep(body)),
      );
      assert.equal(problems.length, 1);
      assert.match(blob(problems[0]), /unreadable/);
      assert.match(blob(problems[0]), refusal);
    });
  }

  // The scanner-level filter. An assembly line carrying an expression is not
  // read at all: bash assigns the SUBSTITUTED text, so the file's literal is
  // not the value. Dropping it books no lane, where judging it would count a
  // lane as referenced on text that never runs. The producer path refuses a
  // `${{ }}` body outright; this is the only bar that reaches the job-wide
  // assembly accounting for a body no runs-on consumes.
  it('does not book a lane from an assembly line carrying an expression', () => {
    const { problems, lanes } = laneTestPlan(
      'probe.yml',
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n` +
        `      - run: |-\n` +
        `          gpu_runner='["self-hosted", "linux", "x64", "ecs-qwen"]' # \${{ github.sha }}\n`,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(lanes, []);
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
