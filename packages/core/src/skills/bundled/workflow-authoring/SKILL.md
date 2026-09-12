---
name: workflow-authoring
description: Reference for writing a Workflow tool script (script API and gotchas, agent() options, pipeline() vs parallel(), verification and convergence patterns, resume, worked example). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.
---

# Workflow authoring reference

Everything below is about _writing_ the script. Whether a workflow may run at
all is decided by the Workflow tool's own opt-in rule — this reference does
not authorize a run.

Reach for one to be comprehensive (decompose the work and cover every part in
parallel), to be confident (independent perspectives and adversarial checks
before an answer is committed to), or to take on scale a single context cannot
hold — migrations, audits, broad sweeps. The script is where that structure is
encoded: what fans out, what verifies, what synthesizes. Parallelism on its own
is not a reason; work that is already one short sequence of edits belongs in
the main loop.

## Scout first, then orchestrate

The strongest pattern is hybrid: discover the work list in the main loop (list
the files, scope the diff, read the failing test), then hand that list to a
workflow. You do not need to know the shape of the work before the task — only
before the orchestration step. When the work has distinct phases, run several
small workflows across turns and read each result before choosing the next,
rather than authoring one large script that runs unattended.

Common single-phase shapes: understand (parallel readers over subsystems,
merged into one map), design (independent approaches, judged, then
synthesized), review (dimensions, find, verify each finding), research (broad
sweep, deep read, synthesis), migrate (discover sites, transform each under
`isolation: 'worktree'`, verify).

## Script contract

The source is wrapped as an async IIFE, so top-level `await` and a top-level
`return` are both legal — and a trailing expression is _not_ a return value.
End every successful path with an explicit `return`.

It is plain JavaScript, not TypeScript, and it cannot `import` anything.

The script may start with a literal `export const meta = {...}` declaration
with `name`, `description`, and optionally `whenToUse` and
`phases: [{ title, detail? }]`. It must be a pure literal — no variables,
calls, or interpolation — and it is stripped before execution, so nothing in
the script body can read it. Fields outside that list are dropped. The
approval dialog prints the name, the description, and each phase title with
its `detail` as a one-line explanation beside it: give every phase a `detail`,
because for a run that may dispatch hundreds of agents it is what the user
reads before approving.

Injected globals, and nothing else:

- `phase(title)` — open a phase. Everything dispatched afterwards is attributed
  to it in the live phase tree, until the next phase opens.
- `log(msg)` — one line into the run log the user watches.
- `agent(prompt, opts?)` — dispatch one subagent. See **agent() options**.
- `parallel(thunks)` — run thunks through the shared concurrency window,
  resolving to a position-aligned array. `parallel()` itself rejects on
  invalid arguments.
- `pipeline(items, ...stages)` — run each item through the stages
  independently. See **Default to `pipeline()`**.
- `workflow(nameOrRef, args?)` — run a saved workflow inline. See **Saved
  workflows and workflow()**.
- `args` — the structured value the caller passed, or `undefined`.
- `budget` — `budget.total` (`null` = uncapped) and `budget.spent()`.

Pass THUNKS to `parallel()`, not eager calls: `parallel([() => agent(...)])`,
not `parallel([agent(...)])`. The eager form is refused outright: a
non-function element rejects the whole batch, and by then every `agent()` in it
has already been admitted, counted against the caps, and spent — with its
result discarded.

A script must be deterministic so a resume replays the same call sequence.
`Math.random()` throws, and so does all of `Date` — `new Date()`,
`Date.now()`, `Date.parse()` and `Date.UTC()` alike. Pass timestamps in via
`args`, or stamp the result after the workflow returns.

Scripts run in a `node:vm` sandbox with no filesystem, shell, network, or
environment access. All I/O happens through the prompts you give the agents, so
say explicitly what each one should read and whether it may edit files.

## agent() options

`agent(prompt, { label?, phase?, schema?, model?, agentType?, isolation?, workingDir?, stallMs? })`

- `label` (string) — the name shown in the run views and the failures list.
  Make it unique per dispatch: a failure line carries only the label and the
  error, so two failed dispatches that share a label cannot be told apart.
- `phase` (string) — opens a named phase at this call, exactly as `phase(title)`
  would: this dispatch and every dispatch issued after it are attributed to that
  phase. It is not scoped to the one call, so in a fan-out open phases with
  `phase()` between groups rather than per dispatch.
- `schema` (JSON Schema object) — the subagent must deliver its result by
  calling `structured_output` with arguments matching the schema; agent()
  resolves to the validated object. After two in-conversation nudges without a
  valid result, it resolves to null and the failure is recorded as "subagent
  completed without calling StructuredOutput (after 2 in-conversation nudges)";
  check for null.
- `agentType` (string) — resolves against the declarative-agents registry
  (`.qwen/agents/<name>.md`, project then user then built-in). Unresolved names
  make the admitted agent() resolve to null and record "agent({agentType}):
  agent type 'X' not found"; check for null.
- `model` (string) — per-call model override; routes provider correctly via the
  subagent runtime view.
- `isolation` — `'worktree'` provisions a fresh git worktree under
  `<projectRoot>/.qwen/worktrees/agent-<7hex>`; the worktree is auto-removed if
  no changes, otherwise the path and branch are returned alongside the result.
  `'remote'` makes the admitted agent() resolve to null and records
  "agent({isolation:'remote'}) is not available in this build". A `'worktree'`
  dispatch is also refused — it resolves to null with the reason recorded —
  when the session is already inside a worktree (nested isolation worktrees are
  not supported; to run agents in that worktree, pass it as `workingDir`), when
  git is not available or the directory is not a git repository, when the
  parent working tree has uncommitted changes (the subagent would see a stale
  HEAD), or when the worktree cannot be created. The nested case refuses every
  dispatch, so rule it out before a large `isolation: 'worktree'` fan-out.
- `workingDir` (string) — pin the subagent to an EXISTING git worktree of this
  repository that the caller owns; nothing is created and nothing is removed.
  Use it when the directory the agent must work in already exists and its
  uncommitted state is the point (a review worktree, a checkout a previous step
  provisioned) — exactly the case isolation cannot serve. Mutually exclusive
  with `isolation`. The path must be a linked worktree of this repository
  registered via `git worktree add` (it may live anywhere on disk) — the main
  checkout is not eligible.
- `stallMs` (number, ms) — a no-progress stall watchdog, not a wall-clock cap.
  The dispatch is aborted and retried (up to 3 attempts total) after this many
  milliseconds with no observable subagent progress — including before the
  first response arrives; the timer is suspended while a tool is in flight, so
  a legitimately slow tool is not a stall. Default 180000 (override via
  `QWEN_CODE_WORKFLOW_STALL_SECONDS`, whole seconds); `0` disables the
  watchdog. Wall time per attempt is bounded separately.

Workflow subagents can never use AskUserQuestion, SendMessage, Monitor,
EnterPlanMode, ExitPlanMode, or the Agent tool, whatever their `agentType`. A
subagent therefore cannot fan out further and cannot ask anyone anything: the
script owns all fan-out, and every ambiguity has to be resolved in the prompt
it is given. Never ask a subagent to spawn its own verifiers — dispatch them
from the script.

## What agent() returns

A subagent's final text, or the validated object under `schema`.

`agent()` resolves to `null` when that admitted agent fails on its own —
including turn/time caps, model or setup errors, missing structured output, and
exhausted stall retries — and it does so for a bare `await agent()` exactly as
it does inside `parallel()`/`pipeline()`, so check for `null` wherever you read
a result. Call-shape validation failures — such as an empty prompt, an
unsupported option combination, or an invalid option value — reject a bare
call; inside `parallel()`/`pipeline()`, the surrounding ordinary thunk or stage
rejection becomes a position-aligned `null`. Run-level rejections no later call
could survive — the token budget, the 1000-agent cap, and cancellation — throw
and end a `parallel()`/`pipeline()` batch. An admitted agent that fails and
settles to `null` still counts as dispatched and is named, with its error, in
the run's failures list; a `null` returned by an ordinary thunk or stage is not
an agent dispatch.

A `pipeline()` stage that returns `null` — or throws — drops that item: its
remaining stages are skipped and its slot in the result is `null`. So a `null`
check belongs in the stage that dispatched the agent, never in a later stage,
which will not run for that item.

A result must be JSON-serializable to survive the sandbox boundary and the
resume journal. A thunk that resolves to something that is not becomes `null`
at its index.

## Limits

- Concurrency: `max(2, min(16, availableParallelism()-2))` agents in flight per
  run — `availableParallelism()` follows CPU affinity and container CPU limits,
  not the host's core count — override via `QWEN_CODE_MAX_WORKFLOW_CONCURRENCY`
  (clamped to 64).
- 1000 `agent()` calls per run, override via `QWEN_CODE_MAX_WORKFLOW_AGENTS`
  (clamped to 10000). The call past the cap throws.
- 30-minute wall-clock cap per run, override via
  `QWEN_CODE_MAX_WORKFLOW_SECONDS` (applied as given). A fan-out near the agent
  cap will not fit inside the default cap.
- 30 seconds for the script's synchronous code before its first `await`, with
  no override. A synchronous loop that runs longer is aborted.
- Per subagent attempt: 50 turns (`QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS`, clamped
  to 500) and 10 minutes (`QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES`, clamped
  to 100). Raise them for legitimately long work rather than letting agents
  come back `null` — but a value above the clamp is silently cut down to it.
- Stall retries: 3 attempts per `agent()` call; the stall timeout itself
  (`QWEN_CODE_WORKFLOW_STALL_SECONDS`) is applied as given.
- Tokens: a per-run output-token cap may be in effect — read `budget.total`
  (`null` = uncapped) before committing to a large fan-out, because once the
  cap is reached every further `agent()` call is refused.

## Default to `pipeline()`

`pipeline()` runs each item through every stage independently — item A can be
in stage 3 while item B is still in stage 1 — so wall-clock is the slowest
single chain. `parallel()` is a barrier: it waits for every thunk before
anything moves on, so it costs the slowest item of every stage.

A barrier is right only when a stage genuinely needs cross-item context:
deduplicating or merging across the full result set before expensive downstream
work, exiting early when the total count is zero, or a prompt that compares one
finding against all the others. It is not justified by needing to flatten, map,
or filter between stages (do that inside a pipeline stage), by two stages being
conceptually separate, or by the code reading more tidily. Smell test:
`parallel()` → a pure transform → `parallel()` is a pipeline someone wrote with
an unnecessary barrier. When in doubt, `pipeline()`.

## Verify before believing

A subagent's answer is a claim, not a result. For findings that matter, spawn
independent verifiers prompted to _refute_, and drop what a majority refutes.
When a claim can be wrong in several different ways, give each verifier a
distinct lens (correctness, security, performance, does it actually reproduce)
— diversity catches what repetition cannot. For a wide solution space, generate
several independent attempts, judge them in parallel, and synthesize from the
winner while grafting the best ideas from the rest.

## Converge deliberately

For discovery of unknown size, keep running finders until some number of
consecutive rounds turn up nothing new; a fixed round count stops partway into
the tail. Deduplicate each round against everything already seen, never against
only what survived judging — otherwise rejected findings reappear every round
and the loop never terminates. A closing pass that asks what is still missing
(a search angle never run, a claim never verified, a file never read) usually
produces the next round of real work.

## Report honestly

Scale the fleet to what was actually asked: a quick check gets a few agents and
one verification pass; an explicit request to be thorough or exhaustive earns a
larger pool and a multi-vote adversarial round. Whenever a run bounds its own
coverage — top-N, sampling, no retry — `log()` what was dropped. Silent
truncation reads as full coverage, which is worse than a smaller honest result.

## Saved workflows and workflow()

`workflow(nameOrRef, args?)` runs a saved workflow inline under this run's caps
and nests one level only — a workflow reached through `workflow()` cannot call
`workflow()` itself, and doing so throws.

It takes one of two forms. `workflow('<name>')` resolves a name against
`<projectRoot>/.qwen/workflows` (project scope, also surfaced as `/<name>`
slash commands) and `~/.qwen/workflows` (user scope, lower precedence when both
define the same name). `workflow({ scriptPath: '<absolute path>' })` loads a
script file directly from either of those directories or from the
generated-scripts root (`$QWEN_CODE_PROJECT_DIR/workflows/generated` — the
per-project runtime dir, not the project tree); a path outside those roots is
refused. A bare string is always a name: a path passed as a string is rejected
as an invalid workflow name. At the top level that rejection ends the run;
inside `parallel()`/`pipeline()` it becomes a position-aligned `null` like any
other thunk rejection — with no agent dispatched and nothing in the failures
list — so null-check a `workflow()` result too.

To create or edit a saved workflow, use the `workflow-creator` skill — it owns
the file layout, naming rules, and the save round-trip.

## Resume and diagnostics

Every run hands back its runId, the script's path on disk, and its journal
path. An inline script is persisted under the generated-scripts root, so a
resume edits that file and passes the path back instead of re-sending the whole
source.

`resumeFromRunId` replays a prior run: each `agent()` call's journal key hashes
its prompt and opts chained in call order, so calls whose rolling prefix-hash
still matches are served from cache for the longest unchanged prefix, and the
first changed or missing call onward runs live. Post-processing after the last
agent can therefore change freely without losing the cache. Pass the same
`args` — they seed the chain, so different args re-run everything.

The journal is one JSON line per event: a `started` line when an agent is
dispatched, then a `result` line when it returns a value or a `failed` line
when it settles without one. Only `result` lines feed the resume cache. A
`started` line with neither after it means the run was interrupted with that
agent in flight — not that the agent is broken. Read the journal before
diagnosing an empty or surprising result: a cached result can itself be empty,
and a `null` slot in the output means an agent failed, not that the work found
nothing.

Runs appear in the background-tasks view and the `/workflows` dialog (live
phase tree, token usage, cooperative pause/resume, cancel);
`run_in_background: true` returns a run handle immediately in the interactive
TUI and delivers completion through the conversation.

## Worked example

Review a change set across several dimensions, verifying each finding as soon
as its dimension is done — a pipeline, so a slow dimension never holds up
verification of a fast one.

```js
export const meta = {
  name: 'Review changes',
  description: 'Review the diff across dimensions and verify every finding',
  phases: [
    { title: 'Review', detail: 'One reviewer per dimension reads the diff' },
    {
      title: 'Verify',
      detail: 'An independent verifier tries to refute each finding',
    },
  ],
};

const DIMENSIONS = [
  {
    key: 'correctness',
    lens: 'logic errors, wrong edge cases, broken invariants',
  },
  {
    key: 'security',
    lens: 'injection, path traversal, secrets, unsafe defaults',
  },
  {
    key: 'performance',
    lens: 'accidental O(n^2), unbounded memory, chatty I/O',
  },
];

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          claim: { type: 'string' },
        },
        required: ['file', 'claim'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT = {
  type: 'object',
  properties: { isReal: { type: 'boolean' }, why: { type: 'string' } },
  required: ['isReal', 'why'],
};

const target = args?.target;
if (!target) {
  throw new Error('args.target is required, e.g. { target: "HEAD~1..HEAD" }');
}

phase('Review');
const reviewed = await pipeline(
  DIMENSIONS,
  // The stage that dispatches an agent is the stage that handles its null:
  // returning null here would drop the dimension and skip the verify stage.
  async (dimension) => {
    const review = await agent(
      `Review the changes in ${target} for ${dimension.lens}. ` +
        `Read the files; do not edit anything.`,
      { label: `review:${dimension.key}`, schema: FINDINGS },
    );
    if (review === null) {
      log(`review:${dimension.key} came back empty — its findings are missing`);
      return [];
    }
    return review.findings;
  },
  (findings, dimension) => {
    phase('Verify');
    return parallel(
      findings.map((finding, index) => async () => {
        const label = `verify:${dimension.key}:${index + 1}`;
        const verdict = await agent(
          `Adversarially verify this claim about ${finding.file}: ` +
            `"${finding.claim}". Try to REFUTE it. Read the code first.`,
          { label, schema: VERDICT },
        );
        if (verdict === null) {
          log(`${label} came back empty — "${finding.claim}" is unverified`);
          return null;
        }
        return { ...finding, verdict };
      }),
    );
  },
);

// A stage that throws drops its dimension to a null slot. Say which ones
// before flattening, or the drop reads as a dimension that found nothing.
reviewed.forEach((entries, index) => {
  if (entries === null) {
    log(
      `${DIMENSIONS[index].key} was dropped before its findings were verified`,
    );
  }
});
const verdicts = reviewed.filter((entries) => entries !== null).flat();
const confirmed = verdicts.filter(
  (entry) => entry !== null && entry.verdict.isReal,
);
const refuted = verdicts.filter(
  (entry) => entry !== null && !entry.verdict.isReal,
);
log(`confirmed ${confirmed.length} finding(s), refuted ${refuted.length}`);
return { confirmed, refuted };
```

Note what the example does with failure: it refuses to run without the input
it needs, handles each `null` in the stage that dispatched the agent, gives
every verify dispatch its own label, `log()`s every dimension and agent it
loses, and returns what the verifiers refuted next to what they confirmed — a
verifier can be wrong too, and nothing is silently omitted.
