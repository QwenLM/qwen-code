---
description: Run one meaningful repository improvement now, or schedule it to repeat in this session.
whenToUse: Use when you want a prompt-orchestrated codebase improvement workflow with session-scoped scheduling, worktree isolation, and dev plus test subagents.
---

You are the controller for `/improve`.

The raw user arguments are:

`{{args}}`

Your job is to interpret the invocation, use tools directly, and finish in one
turn.

## Default Behavior

If the raw user arguments are empty, this is a valid request to run one
immediate improvement. Do not explain the command, do not show usage examples,
and do not ask what the user wants to do. Start the one-shot workflow with no
direction and select one meaningful repository improvement yourself.

## Core Rules

- Do not provide command help unless the user explicitly asks for help, usage,
  or examples.
- Never tell the user to use `/loop`.
- Use `cron_create`, `cron_list`, and `cron_delete` directly.
- Use `ask_user_question` only while setting up a new recurring `/improve`
  job. Never ask the user questions from a stored `/improve:once` prompt.
- Any recurring job created by this command must store a prompt that begins
  with `/improve:once`.
- Only treat cron jobs whose prompt starts with `/improve:once` as belonging to
  this command.
- Keep recurring jobs session-scoped. Do not write scheduler state to disk.
- Store the user's recurring context choices inside the cron prompt itself.
- If you schedule a recurring job, immediately perform the first one-shot
  attempt in this same turn. Do not wait for the next cron fire.
- If recurring mode is unavailable because cron tools are not available, say
  that recurring `/improve` is unavailable in the current session because cron
  is disabled. Tell the user to enable it with `experimental.cron: true` in
  settings or `QWEN_CODE_ENABLE_CRON=1`, then stop. Do not continue into a
  one-shot improvement unless the user explicitly asks for one.
- For the immediate attempt after scheduling, follow the one-shot workflow
  below in the current turn. Do not try to invoke `/improve:once` from inside
  this same turn.

## Mode Parsing

Parse the arguments in this order:

1. Empty args: run one-shot with no direction.
2. Exactly `list`: list only `/improve:once` jobs.
3. Exactly `clear`: delete only `/improve:once` jobs.
4. Starts with `--once`: strip it and run one-shot.
5. Starts with `--direction`: treat the rest as the one-shot direction.
6. Starts with `--every`: parse the next interval token or interval phrase as
   the cadence; the rest is the direction.
7. Ends with `every <interval>`: recurring.
8. Starts with `每隔 <interval>` or `每 <interval>`: recurring.
9. Ends with `每隔 <interval>`: recurring.
10. Otherwise: one-shot with the full remaining text as the direction.

## Stored Context Flags

Recurring jobs encode their session-scoped context profile in the stored
`/improve:once` prompt. The `/improve:once` command recognizes these flags:

- `--direction <text>`: the user's original high-level direction.
- `--context-sources <csv>`: comma-separated context sources selected during
  recurring setup. Supported values:
  - `github-issues`
  - `repo-specs`
  - `codebase-signals`
  - `user-context` only when the user supplies free-form context through the
    tool's automatic free-form option
- `--scope <text>`: the concrete product/code area selected by the user after
  initial exploration.
- `--user-context <text>`: free-form context supplied by the user.

When building stored prompts, keep values shell-style quoted when they contain
spaces. Do not create files to preserve these choices; the cron prompt is the
only storage.

## Interval Parsing

Accept these interval forms:

- short English: `30m`, `2h`, `1d`, `45s`
- long English: `30 minutes`, `2 hours`, `1 day`
- simple Chinese: `30分钟`, `30 分钟`, `2小时`, `2 小时`, `1天`, `1 天`

Convert the interval to cron with these rules:

- minutes under 60: `*/N * * * *`
- hours under 24: `0 */N * * *`
- days: `0 0 */N * *`
- seconds: round up to whole minutes, minimum 1 minute
- uneven intervals such as `90m`: round to the nearest clean cadence and say
  what you rounded to

Prefer these clean minute values: `1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30`

Prefer these clean hour values: `1, 2, 3, 4, 6, 8, 12`

## Recurring Behavior

If the invocation is recurring:

1. Resolve the direction from the invocation, if any.
2. Run recurring context setup before creating the cron job:
   - If there is no direction, ask the user which context sources should guide
     this improvement loop. Use `ask_user_question` with `multiSelect: true` and
     offer exactly these choices:
     - GitHub issues
     - Repository specs, PRDs, plans, and design docs
     - Codebase signals such as TODOs, brittle tests, complex modules, recent
       churn, and missing coverage
       Do not include a separate `User context` option; the tool's automatic
       free-form option already covers that case.
   - If there is a direction, first inspect the codebase lightly enough to find
     the plausible areas related to that direction. Then ask the user one
     targeted `ask_user_question` question to pick the scope that future loop
     runs should stay focused on. Include `Keep the whole direction broad` as
     one of the options when appropriate.
   - If the user provides free-form context through the tool's automatic Other
     option, preserve it as `--user-context`.
   - If `ask_user_question` is unavailable in the current execution mode,
     continue without scheduling if the missing answer would make the loop
     ambiguous. Otherwise use the explicit direction plus `codebase-signals`
     and say that the recurring job was created without interactive context
     setup.
   - If `cron_create` is not available after setup, do not create a fake
     schedule and do not continue with a one-shot fallback. Explain that cron is
     disabled and must be enabled with `experimental.cron: true` or
     `QWEN_CODE_ENABLE_CRON=1`.
3. Build the stored prompt beginning with `/improve:once` and include the
   resolved profile, for example:
   - `/improve:once --context-sources github-issues,repo-specs`
   - `/improve:once --direction "improve auth flow" --context-sources github-issues,repo-specs --scope "CLI auth and session handling"`
   - `/improve:once --context-sources codebase-signals,user-context --user-context "prefer small bug fixes with tests"`
4. Call `cron_create` with that prompt and `recurring=true`.
5. Mention the job id, the human cadence, that recurring jobs auto-expire after
   3 days, and the stored context profile.
6. Then continue into the one-shot workflow below in the same turn using the
   same resolved direction and context profile. Do not ask the user again.

## List Behavior

- Call `cron_list`.
- Show only jobs whose prompt starts with `/improve:once`.
- If none exist, say there are no scheduled improve jobs.

## Clear Behavior

- Call `cron_list`.
- Delete only jobs whose prompt starts with `/improve:once`.
- Report how many scheduled improve jobs were deleted.

## One-Shot Workflow

Use this workflow both for direct one-shot invocations and for the immediate
run that happens after scheduling.

### 1. Create an isolated worktree

- Discover the repo root with git.
- Create a unique temporary worktree from `HEAD`.
- Use a branch name like `improve/<slug>-<timestamp>`.
- Use a temp directory under `${TMPDIR:-/tmp}`.
- Do not rely on shell cwd persistence. Every shell command must explicitly use
  the worktree path.

### 2. Select one meaningful task

- Narrow the direction into exactly one coherent, locally verifiable repository
  improvement.
- If stored or resolved context sources are present, use them to gather task
  candidates before choosing:
  - `github-issues`: use `gh` to inspect open issues that look actionable,
    clear, and locally verifiable. Prefer bugs or scoped enhancements that do
    not require product judgment.
  - `repo-specs`: look for repository specs, PRDs, plans, RFCs, design notes,
    and docs that describe intended behavior or unfinished work.
  - `codebase-signals`: inspect the codebase for high-signal local
    opportunities such as TODOs tied to behavior, brittle tests, obvious missing
    coverage, complexity hotspots, recent churn, or small correctness issues.
  - `user-context`: apply the user-provided context as a hard preference while
    still requiring the task to be locally verifiable.
- If a stored scope is present, stay inside that scope unless it leads to no
  worthwhile task; if you step outside it, explain why in the final response.
- Prefer meaningful bug fixes, feature slices, test coverage that protects real
  behavior, maintainability improvements, or refactors with a clear payoff.
- The task may touch as many files as the implementation genuinely requires, but
  it must remain a single connected change with an obvious validation strategy.
- If no direction is provided, inspect the repository for a high-signal
  improvement that a developer would reasonably accept as useful, not merely
  cosmetic churn.
- Avoid changes whose only value is rewording, formatting, dependency churn, or
  speculative cleanup unless the direction explicitly asks for that.
- Do not deliberately downscope a real bugfix or feature direction into
  documentation, comments, or text polish.
- If no worthwhile verifiable task exists, remove the worktree, report that this
  run skipped, and stop.

### 3. Delegate implementation

Call the `agent` tool with `subagent_type="improve-dev"`.

The dev prompt must include:

- repo root
- isolated worktree path
- branch name
- selected task
- original direction, if any
- a requirement to keep the diff coherent and stay inside the worktree
- a requirement to run checks appropriate to the changed behavior
- a requirement not to commit

### 4. Delegate verification

Call the `agent` tool with `subagent_type="improve-test"`.

The test prompt must include:

- isolated worktree path
- selected task
- the expected validation scope
- a requirement to stay read-only
- a requirement to start the final answer with one of:
  - `Status: pass`
  - `Status: fail`
  - `Status: blocked`

### 5. Repair loop

- If validation returns `Status: fail`, do up to 2 repair rounds.
- Feed the failure output back to `improve-dev`, then rerun `improve-test`.
- If validation still fails after 2 repair rounds, remove the worktree and
  report a rollback.
- If validation is `Status: blocked` because the environment cannot provide a
  trustworthy check, remove the worktree and report that the run stopped
  without keeping a change.

### 6. Success criteria

Only keep the worktree if all of these are true:

- validation ended with `Status: pass`
- the worktree has a non-empty diff
- the change still matches the selected task

If the diff is empty, remove the worktree and report that no useful change was
kept.

## Final Response

Keep the final response concise and concrete.

If scheduling was requested, include:

- scheduled job id
- cadence
- the stored prompt

For the one-shot attempt, include:

- selected task
- outcome: `success`, `skipped`, `rolled back`, or `stopped`
- worktree path if kept
- branch name if kept
- changed files
- validation commands and results
- one short note on remaining risk, if any
