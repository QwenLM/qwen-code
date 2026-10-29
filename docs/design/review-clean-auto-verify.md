# Auto-verify a pull request whose review came back clean

[English](review-clean-auto-verify.md) | [简体中文](review-clean-auto-verify.zh-CN.md)

Status: implemented in this change.

## Problem

A maintainer who runs `/review <pr>` and gets a clean verdict still has to
notice that verdict, decide the change deserves behavioural evidence, and start
`/verify-pr <pr> --publish` by hand. Nothing in the product connects the two, so
the handoff is a human habit: it is skipped exactly when the maintainer is busy,
and it is re-derived per platform.

The obvious shortcut — trigger the verification from GitHub Actions after the
bot review posts an approve — was rejected. The review pipeline already serves
more than GitHub (`packages/cli/src/commands/review/lib/platform/` has a GitHub
and an Aone provider behind one registry), and GitLab is a stated direction. A
workflow trigger is GitHub-only by construction, runs outside the operator's
session, and cannot create a sub-session. The handoff belongs inside qwen-code.

**The reviewer is not necessarily qwen-code.** A PR may be reviewed by another
agent (Codex, Claude Code), by the CI bot, or by a person. An entrance welded to
qwen-code's own review pipeline covers none of those, so the event contract has
to be reachable from outside it, and the consumer has to be able to act on an
event that names no qwen-code session.

## Current state

Verified against the tree this change is built on:

- The verdict authority is `qwen review compose-review`, persisted by
  `qwen review save-artifact` as `.qwen/reviews/<report>.json`
  (`ReviewArtifactV1`: `target`, `effort`, `verdict`, `findings`, `counts`,
  `markdownReportPath`). `save-artifact` runs in Step 8, after Step 7 submitted
  and after any Step 6B re-compose, and before Step 9 cleanup sweeps
  `.qwen/tmp`.
- `compose-review` already computes whether a round may certify the range it
  reviewed. `anchorFailsClosed(cappedBy, scopeUnproven, dimensionGapsAreDepthOnly)`
  gates the `sha` field of the `qwen-review-ledger` marker embedded in the
  composed body: the anchor is withheld on any undecided blocker, unproven
  coverage, or any cap the module derived other than depth-only
  `unreviewed-dimension`. The marker is the persisted form of that decision.
- The plan report `fetch-pr` writes (`.qwen/tmp/qwen-review-pr-<n>-fetch.json`)
  carries the target identity: `prNumber`, `ownerRepo`, `host` (null for
  github.com), `fetchedSha`. `compose-review` reads the same file through
  `planPrIdentity`.
- Session identity reaches review subcommands through `QWEN_CODE_SESSION_ID`,
  exported by `packages/core/src/services/shellContextEnv.ts` and already read
  by `review/lib/paths.ts`, `review/lib/transcripts.ts` and
  `review/lib/run-ledger.ts`.
- The daemon can spawn a sub-session: `createSubSessionLauncher`
  (`packages/cli/src/serve/create-sub-session.ts`) is wired as the bridge's
  `onCreateSubSession`, with per-caller and workspace-wide concurrency caps and
  a depth-1 nesting gate. `launch` requires a `callerSessionId` and resolves it
  through `bridge.getSessionSummary`.
- The daemon already has the shape of consumer this needs:
  `startScheduledTaskKeepalive` (`packages/cli/src/serve/scheduled-task-keepalive.ts`)
  combines an interval tick with an `fs.watch` + debounce on a durable JSON
  file, an in-flight guard, `unref`'d timers, and an `activeWork` signal the
  workspace lifecycle reads. It is started per trusted workspace from
  `server.ts` and stopped through `app.locals`.
- Host-trusted review state lives outside every repository workspace:
  `reviewTrustStateDir(repositoryRoot)` resolves to
  `<globalQwenDir>/review-state/<projectHash>`.
- `/verify-pr` is a project skill (`.qwen/skills/verify-pr/`). Its local
  maintainer round resolves coordinates with `gh`
  (`scripts/verify-pr-prepare.mjs`); it has no `--host` flag and no Aone or
  GitLab backend today.

## Goals

- A review round that ended clean produces a durable, platform-neutral event.
- The daemon consumes that event and spawns a sub-session running
  `/verify-pr <number> --publish --repo <owner>/<repo>`, without the model
  having to remember the handoff.
- The mechanism is opt-out, not opt-in, and a repository cannot change the
  policy for its reviewers.
- Adding a platform later must not change the event schema or the consumer's
  control flow.
- Adding a producer later must not change the consumer at all: any agent, a
  script, or a person can record the same event, and an event that names no
  qwen-code session is still actionable.

## Non-goals

- No GitHub Actions trigger, no new workflow, no CI change.
- No Aone or GitLab implementation of `/verify-pr`. The event carries the
  platform; the consumer declines targets it cannot verify yet and says why.
- No new hook event, no public event bus, no REST route. The event is a durable
  record consumed by one built-in automation, and the CLI is its entrance: a
  local producer needs no daemon socket, no token, and no running daemon. A
  route would only add reach for a producer on another machine, which is not a
  case here.
- No automatic observation of reviews on platforms other than GitHub: the
  observer reads GitHub GraphQL, so an Aone or GitLab watch is registered and
  declined with a reason until a provider backend exists.
- No change to the review verdict, the ledger marker, or the posting rules.

## Solution

### 1. The event

`packages/cli/src/commands/review/lib/review-events.ts` owns the schema, the
directory, the writer and the reader.

```jsonc
{
  "schemaVersion": 1,
  "eventId": "<sha256 of the dedupe key, 16 hex>",
  "createdAt": "<ISO-8601>",
  // Optional: only qwen-code's own pipeline has a session to name. Without it
  // the consumer spawns a top-level automation session, not a sub-session.
  "sessionId": "<QWEN_CODE_SESSION_ID, when exported>",
  // Who asserted the head was clean — attribution for a public-comment action.
  "reviewedBy": "qwen-code/save-artifact",
  "target": {
    // A plain string, not today's provider union: a provider added later must
    // still be readable. The consumer decides what it can serve.
    "platform": "github",
    "host": "github.com",
    "ownerRepo": "QwenLM/qwen-code",
    "number": 15846,
    "headSha": "<the head the review actually read>",
  },
  "round": 3,
  "verdict": { "event": "APPROVE", "critical": 0, "suggestion": 2 },
  // Optional: an external producer has no qwen-code artifact.
  "artifactPath": "<workspace-relative path of the saved review artifact>",
}
```

The reader enforces the contract rather than trusting the writer: `verdict.event`
must be `APPROVE` or `COMMENT` and `verdict.critical` must be `0` (the record IS
the clean assertion), `headSha` must be hex, and `ownerRepo`/`host` must fit a
charset that cannot carry a second flag into the prompt. A record that fails any
of these is reported unreadable and never spawned.

Location: `<reviewTrustStateDir(root)>/verify-events/pending/<eventId>.json`.
Host-trusted, outside the repository, for the same reason the rest of
`review-state` is: a pending event causes the daemon to spawn a session that
executes PR code and publishes a comment. A repository that could write one
could choose the prompt. The event file name is the dedupe key's digest, so a
re-emission for the same head overwrites the same file instead of queueing a
second round.

Dedupe key: `platform:host:ownerRepo:number:headSha`. Round is deliberately not
in it — two clean rounds at the same head are one verification, not two.

### 2. The producers

Two entrances write the same record. The consumer cannot tell them apart except
by `reviewedBy` and the presence of a `sessionId`, and no gate below depends on
either.

**E1 — `qwen review verify-event`, for any producer.** Another agent, a script,
or a person records the handoff explicitly:

```bash
qwen review verify-event --pr 15846 --repo QwenLM/qwen-code \
  --head <the sha the review read> --reviewed-by codex
```

Offline by construction: it reads no platform and needs no credentials, so a
producer can hand off without a GitHub token, and the daemon need not be running
yet — the record is durable and is picked up whenever it next is. `--host` is
required off GitHub (there is no default host, the same refusal `review meta`
makes); `--session-id` defaults to `QWEN_CODE_SESSION_ID` and is normally absent
for an external caller. Usage errors exit 2, a write failure exits 1, and stdout
carries one JSON object. The caller asserts the two facts it is responsible for:
which head was read, and that the round found no Critical.

**E3 — `saveReviewArtifact`, for qwen-code's own rounds.** Zero configuration:
the event is emitted after the artifact is written, best-effort — a failure to
emit is disclosed on stderr and never fails the command, the same posture
`record_artifact` has in Step 8.

The internal trigger predicate is computed from inputs the command already
reads:

1. `counts.bySeverity.critical === 0`.
2. The composed body's ledger marker parses (`parseLedger`) and carries a `sha`.
   That is the module's own "this round certified its scope" decision, already
   evaluated with inputs (`scopeUnproven`, `dimensionGapsAreDepthOnly`) that are
   not all persisted — re-deriving it from `cappedBy` alone would be a second,
   weaker predicate that drifts from the first.
3. The plan report beside the composed input resolves a PR identity
   (`planPrIdentity`-shaped: `ownerRepo`, positive `prNumber`, hostname-shaped
   `host`). The path is the deterministic sibling
   `.qwen/tmp/qwen-review-<target>-fetch.json`, the same convention
   `compose-review` uses for `qwen-review-pr-<n>-prev-ledger.json`. No new flag,
   no network call, no prose change in the skill.

`verdict.event` must be `APPROVE` or `COMMENT`; a `REQUEST_CHANGES` round with
zero counted Criticals is a contradiction the consumer must not act on.

The platform is resolved with `detectPlatformKind({ host })` — read-only, never
throws, no authentication — so an Aone target produces an Aone event.

### 3. The consumer

`packages/cli/src/serve/review-verify-automation.ts` mirrors
`startScheduledTaskKeepalive`: an interval tick (60 s backstop) plus an
`fs.watch` on the pending directory with a 500 ms debounce, one in-flight pass
at a time, `unref`'d timers, `activeWork` for the workspace lifecycle, and an
idempotent `stop()`.

Each pass, per pending event:

| Gate                                                                 | Decline reason         |
| -------------------------------------------------------------------- | ---------------------- |
| `review.autoVerify` is on (operator scopes only)                     | `disabled`             |
| `target.platform === 'github'` and `target.host === 'github.com'`    | `unsupported-platform` |
| `.qwen/skills/verify-pr/SKILL.md` exists in the workspace            | `skill-unavailable`    |
| `sessionId` present, **or** a bridge is wired for a parentless spawn | `no-session`           |
| dedupe key absent from `spawned.json`                                | `already-verified`     |

A declined event is removed from `pending/` and the reason is logged; it is not
retried. An event that cannot be acted on now will not become actionable later
without a new review round, which writes a new event.

An accepted event is processed write-ahead:

1. Append the dedupe key to `spawned.json` (bounded, FIFO, 200 entries).
2. Spawn, by which producer wrote the event:
   - **Names a session** → `launch({ prompt, completion: 'sent',
callerSessionId, name })`, the workspace's own sub-session launcher, so the
     per-caller and workspace caps and the depth-1 gate apply and the UI can
     link the round back to the review.
   - **Names none** → `spawnReviewVerifySession`, a TOP-LEVEL session through the
     bridge (`spawnOrAttach` thread scope → name → `sendPrompt`), the same
     sequence the launcher's own non-standalone path uses minus the parent
     lineage. The launcher cannot serve this case: `callerSessionId` is required
     and keys both its concurrency bucket and its nesting gate. Concurrency here
     is bounded by the bridge's `maxSessions` admission and by the per-head
     dedupe upstream; a prompt-dispatch rejection is reported, not swallowed.
3. Delete the pending file.

Recording before spawning is deliberate: a daemon that dies between the two
must not replay a round that may already have published a comment. The cost is
that a failed spawn is not retried — the failure is logged with its reason and
the operator can run `/verify-pr` by hand. Never double-publishing outranks
never missing a round for a feature whose output is a public comment.

The prompt is `/verify-pr <number> --publish --repo <ownerRepo>` on both paths.
The session runs in the same workspace, so the project skill and the operator's
`verifyPr.assetsRepo` coordinates apply unchanged, and the daemon's existing
`/verify-pr` prompt admission binds the PR badge to the new session.
`completion: 'sent'` (and the parentless path's fire-and-forget dispatch) keeps
the reviewing session unblocked. The spawn notice names `reviewedBy`, so a
public comment triggered by another agent's assertion is attributable in the
daemon log.

### 4. The policy

`review.autoVerify`, boolean, default `true`, added to the `review` settings
group and read through `operatorReviewSettings()` — which loads with
`skipWorkspaceSettings: true`, so User, System and SystemDefaults decide and a
repository's own `.qwen/settings.json` is ignored. The consumer re-reads it each
pass that has work, so flipping it off takes effect without a restart, and a
quiet workspace reads no settings at all.

One deliberate asymmetry: when the settings cannot be loaded **at all**, the
field degrades to `false`, not to its schema default. That loader's existing
contract is "a degrade writes nothing public" (`comment` degrades off for the
same reason), and this handoff publishes a report comment. A readable file with
a garbled non-boolean value still defaults on — that operator never expressed a
policy, rather than having lost one.

### 5. Wiring

`server.ts` starts the automation beside the keepalive in
`startKeepaliveForWorkspace`, against the same trusted-workspace predicate and
the same `WorkspaceRuntime`, and the existing keepalive-named `app.locals`
start/stop hooks govern both. `run-qwen-serve.ts` needs no new call site: the two
that already start and stop the keepalive for an added or draining runtime now
cover this automation too.

`WorkspaceRuntime` gains an optional `subSessionLauncher`, set at all three
construction sites (primary, secondary, dynamic workspace), so the automation
calls the runtime's **own** launcher — the same one wired into its bridge as
`onCreateSubSession` — and inherits its concurrency caps and depth-1 gate. A
runtime built without a launcher gets no automation rather than a borrowed one.

Unlike the keepalive, the automation takes **no runtime base dir**. Its directory
hangs off `Storage.getGlobalQwenDir()`, which reads `QWEN_HOME` (or the home
directory) and never the runtime-base context, and off the canonical repository
root. A workspace `.env` cannot redirect `QWEN_HOME` — it is a hardcoded project
exclusion — so the reviewing session's CLI subprocess and the daemon resolve the
same directory by construction. Wrapping the pass in
`Storage.runWithResolvedRuntimeBaseDir` would imply a dependency that does not
exist.

The whole block sits under `deps.manageScheduledTaskSessions`, which
`run-qwen-serve.ts` sets to `opts.profile !== 'hosted-harness'`. The handoff
therefore runs in an ordinary daemon and is off in the hosted-harness profile —
the same class of background session-spawning automation, under the same switch.

### 6. Observing reviews qwen-code did not perform (E2)

E1 still needs the reviewer to call it. `review/lib/review-verify-observe.ts`
needs nothing from them: it reads the approval state the platform already
holds, so a review posted by another agent, the CI bot, or a person hands off
by itself.

```bash
qwen review verify-watch 15846 --repo QwenLM/qwen-code   # register
qwen review verify-watch --list                          # inspect
qwen review verify-watch --once                          # run one pass now
qwen review verify-watch 15846 --repo QwenLM/qwen-code --remove
```

The watch list and the observation cursor live beside the events
(`watches.json`, `observed.json`), host-trusted, keyed by coordinates rather
than by head — a watch spans heads. The daemon re-reads every watch on a five
minute interval (one GraphQL call each), and an emitted event is consumed by the
same file pass immediately rather than waiting for the next interval.

**The criterion** (`judgeCleanApproval`, a pure function):

- `state === 'OPEN'` and not a draft;
- `reviewDecision === 'APPROVED'` — the aggregate GitHub recomputes, **not** a
  review body. A new head dismisses an earlier approval while that review's
  body still says "Approving"; reading the body would verify a head nobody
  approved;
- no thread with `isResolved: false` and `isOutdated: false`. Every unresolved
  non-outdated thread counts as a blocker: classifying which are "only
  questions" would mean judging severity from prose, a second weaker judgement
  than the pipeline's own, and the wrong direction to fail in;
- a cut `reviewThreads` connection (`hasNextPage`) is **not** clean — an unread
  page may hold the blocker.

Attribution comes from the approvals whose `commit.oid` equals the current
head, recorded as `reviewedBy: github:<logins>`; an approval of an earlier
commit is not one of them.

**Why a separate observer, not a new action on the `autofix-pr` probe.** That
probe keeps one cursor per PR and its gate wrapper refuses coexistence, because
a second consumer eats the transitions the first needs. A daemon poller sharing
it would starve the autofix and `/verify-pr --watch` sessions that own it. This
observer keeps its own state and asks for the three facts it needs instead of
the probe's thirty. The cost is one extra call per watched PR per interval.

**Why the reader is async.** The review subcommands' shared `gh()` helper is
`execFileSync` with a synchronous retry loop — right for a batch CLI, wrong
inside the daemon, where it would stall every session it serves. The observer
calls `gh` through `execFile` with a 30 s ceiling and lets the poll interval be
the retry. The host rides in the child's env, not through `setGhHost`, which
mutates module-global state the daemon shares.

Two cursors, two jobs: `observed.json` stops this observer re-handing-off a head
it already emitted; the consumer's `spawned.json` stops a second spawn for a
head verified through any producer. A lost observation cursor therefore costs a
re-read, never a duplicate verification — and a head already verified elsewhere
is adopted into it so the poll stops treating it as a candidate.

## Design decisions

- **The entrance is a contract, not a pipeline hook.** The first cut emitted only
  from `save-artifact`, which silently assumed qwen-code performed the review.
  It does not: another agent, the CI bot, or a person may have. So the record is
  the interface and `review verify-event` is a producer anyone can call, with the
  internal emission demoted to one caller among others. No consumer gate reads
  the producer.
- **A parentless event spawns a top-level session, not a declined one.** The
  launcher's `callerSessionId` is required and keys its caps and nesting gate, so
  an external event cannot use it. Declining such events (the first cut's
  `no-session`) would have made the open entrance useless. The bridge path is the
  same spawn sequence the launcher itself uses, minus lineage.
- **`save-artifact`, not `compose-review` or `submit`, for the internal
  producer.** compose-review runs before Step 6B may fix findings and re-compose,
  so an event there can describe a verdict the round later changed. `submit` only
  runs on posting rounds. `save-artifact` is the terminal persistence of the final
  verdict on every medium/high round, posting or not.
- **The ledger anchor, not a new cap list.** The clean-round decision already
  exists in code and is already persisted. A second predicate over `cappedBy`
  would silently diverge from it the first time a cap is added.
- **Host-trusted directory.** Repository-writable state must not be able to
  choose a prompt the daemon executes.
- **Write-ahead dedupe, drop on failure.** The failure direction is a missing
  verification round, never a duplicate public comment.
- **`github.com` only, for now.** `/verify-pr` has no `--host` flag, so a GHE
  target cannot be expressed in the prompt; guessing `GH_HOST` from the ambient
  environment would verify the wrong instance. The event still records the host,
  so lifting the gate later is a consumer change, not a schema change.
- **No new hook event.** A hook surface would need a subprocess-to-session
  event channel that does not exist. The durable record plus one built-in
  consumer is the whole mechanism, and a hook event can be layered on the same
  record later without moving the producer.

## Constraints and risks

- On the sub-session path, the parent session must still be resident when the
  event is consumed. The internal event is written mid-turn (Step 8), so the
  watch fires while the review session is active; a replay after a daemon
  restart can find it reaped, and `launch` then fails and is logged. The
  parentless path has no such constraint.
- The spawned session executes untrusted PR code. It inherits the isolation
  posture of a manually invoked `/verify-pr` round; this change does not weaken
  it and does not add a sandbox of its own. An external producer's assertion of
  "clean" is not independently re-checked — that is E1's trust model: the caller
  runs with the operator's own authority, and the record carries `reviewedBy` so
  the assertion is attributable.
- Event files are small and bounded by the dedupe key, but `pending/` is only
  drained by a running daemon. A workspace whose daemon never runs accumulates
  one file per clean head; the files are inert without a consumer.
- The automation is workspace-scoped and trusted-workspace-gated, like the
  keepalive beside it. It never falls back to another runtime.
- `ownerRepo` and `host` are interpolated into the prompt the daemon executes.
  The producer validates them against the platform's grammar (`isOwnerRepo`,
  `HOSTNAME_RE`) and the reader independently holds them to a charset that
  cannot carry a second flag or a shell metacharacter — the spawning side does
  not inherit its boundary from whoever wrote the file. Such an event is
  reported unreadable and never spawned.

## Validation plan

Unit tests (collocated, vitest):

- `review/lib/review-events.test.ts` — the predicate's three inputs and their
  negatives (critical > 0; marker absent; marker without `sha`; `REQUEST_CHANGES`;
  plan missing or not naming a PR), the dedupe key's stability across rounds,
  atomic overwrite on re-emission, the host-trusted location, the reader's
  refusal of injection-shaped coordinates, and readability of an event from a
  provider added later.
- `review/save-artifact.test.ts` — a clean PR round emits one event; a capped
  round, a local target and a low-effort refusal emit none; an emission failure
  does not fail the command.
- `review/verify-event.test.ts` — an external producer's round is recorded and
  reads back through the consumer's reader; attribution and session defaults;
  an explicit Aone host is recorded as Aone without contacting it; uppercase
  head normalization collapses to one dedupe key; every malformed coordinate is
  a usage error that writes nothing; an Aone-origin cwd with no `--host` is
  refused rather than labelled github.com; a write failure is a runtime error;
  the handler's stdout JSON and exit codes.
- `serve/review-verify-automation.test.ts` — each decline gate; the accepted
  path's write-ahead order (key recorded before `launch`, pending file removed
  after); a failing `launch` leaves the key recorded and drops the event;
  duplicate events for one head spawn once; `stop()` is idempotent and aborts
  the watch. Parentless path: a sessionless event spawns a TOP-LEVEL session
  (thread scope, no `parentSessionId`) with the exact prompt and title, never
  touches the launcher, dedupes like any other head, and surfaces a prompt
  dispatch rejection; with no bridge wired the same event declines `no-session`.
- `review/lib/review-settings.test.ts` — `autoVerify` defaults on, survives only
  as a boolean, degrades off when settings cannot be read, and is read from
  operator scopes.
- `commands/review.test.ts` — the subcommand surface and its `demandCommand`
  enumeration include `verify-event`.
- `review/lib/review-verify-observe.test.ts` — the criterion's every negative
  (merged, draft, not approved, no head, unreadable, threads unreadable, an open
  blocker, a cut thread page), the dismissed-approval trap, resolved/outdated
  threads not blocking, attribution only at the current head; watch list
  add/replace/remove and its host-trusted location; one handoff per head, a new
  head handed off, a head verified elsewhere adopted not re-emitted, a
  non-GitHub watch declined without a fetch, a failed read reported without
  losing the watch, one failing watch not stopping the others, and a lost
  cursor costing a re-read rather than a second spawn.
- `review/verify-watch.test.ts` — register/list/remove/`--once`, coordinates
  resolved through the shared validator, an Aone watch registered as Aone, and
  every malformed invocation a usage error that writes nothing.
- `serve/review-verify-automation.test.ts` (observation duty) — the interval
  observes and spawns for what it finds, through the parentless path; the
  operator switch stops observation entirely; `stop()` halts it.

Manual/E2E (`.qwen/e2e-tests/review-clean-auto-verify.md`): a real `/review` of a
clean PR in a daemon session produces the event and a sub-session that runs
`/verify-pr --publish`; an external `review verify-event` produces a top-level
session; turning `review.autoVerify` off produces the event and no session.

## Acceptance criteria

- A clean PR review round in a daemon session writes exactly one pending event
  under the host-trusted review-state directory, carrying platform, host,
  owner/repo, number, reviewed head sha, round and verdict counts.
- The daemon spawns one sub-session whose prompt is
  `/verify-pr <number> --publish --repo <owner>/<repo>`, and the pending file is
  gone afterwards.
- `qwen review verify-event --pr <n> --repo <o/r> --head <sha> --reviewed-by
<agent>` run by any external producer writes the same record, and the daemon
  spawns a TOP-LEVEL session with the same prompt — no qwen-code session
  required, no daemon running at write time required.
- A round with a Critical, a fail-closed cap, a local/file target, or a
  non-github.com platform spawns nothing.
- Two clean rounds at the same head spawn one verification, whichever producer
  wrote them.
- A registered watch whose PR reaches `reviewDecision: APPROVED` with no
  unresolved non-outdated thread hands off that head once, with no action from
  the reviewer, and spawns the same top-level session; a dismissed approval, an
  open blocker, a draft, or a cut thread page hands off nothing.
- `review.autoVerify: false` in User settings stops the spawn without stopping
  the event; a workspace-scoped value of either sign is ignored.
- `npm run build`, `npm run typecheck` and the touched packages' unit tests pass.

## Follow-ups

- Aone and GitLab backends for `/verify-pr`, then lifting the consumer's
  platform gate. The observer reads GitHub GraphQL today, so observation on
  other platforms goes through the review provider registry; the watch list,
  the criterion's shape and the event contract do not change.
- A `--host` flag for `/verify-pr` so GitHub Enterprise targets can be expressed.
- Resolve the skill the way a session does (user and extension scopes), not only
  the workspace's project copy. Today an operator who installed `verify-pr` at
  user scope gets a disclosed `skill-unavailable` decline rather than a spawn.
- Derive watches automatically (from a workspace's bound PRs, or from the first
  handoff for a PR) so observation needs no explicit registration. Today a watch
  is an operator decision, which keeps the network spend opt-in per PR.
- An optional hook event over the same record, for operators who want their own
  consumer instead of the built-in one.
