# E2E Test Plan: Session Issue Binding Derived From Bound PRs

## Scope

The daemon's PR refresh sweep snapshots the issues each bound PR closes
(GitHub `closingIssuesReferences`, with state) into the existing `.pr.json`
sidecar; the Web Shell tooltip lists them and sidebar search matches their
numbers. No new write path, sidecar, or env switch.

## Baseline dry-run

```bash
qwen --version
```

With the released CLI, a session bound to a PR whose body says `Fixes #N`
shows only the PR in the session tooltip; searching `N` in the sidebar does
not find the session; the sidecar entry carries no `issues` field.

## Group A: core contract

```bash
cd packages/core
npx vitest run src/services/session-pr-service.test.ts src/utils/github-pr-issues.test.ts
```

Expected: an `issues` list round-trips; a non-http(s) issue url, an unknown
issue state, or more than 10 issues voids the sidecar; a same-PR re-bind
keeps the snapshot while a foreign-repo re-bind drops it;
`updateSessionPrStates` writes `issues` with or without a `state` and skips
the write when nothing changed. The GraphQL wrapper aliases one
`pullRequest(number:)` per PR, maps OPEN / CLOSED+COMPLETED /
CLOSED+NOT_PLANNED / CLOSED+DUPLICATE to open / completed / not_planned /
not_planned, keeps resolved aliases when gh exits non-zero over a NOT_FOUND
number, chunks at 100, and maps a missing binary to `cli_unavailable`.

## Group B: daemon sweep and listing

```bash
cd packages/cli
npx vitest run src/serve/server/session-pr-refresh.test.ts
npx vitest run src/serve/server.test.ts -t sidecar
cd ../acp-bridge && npx vitest run src/bridge.test.ts -t "SessionPrs|re-bind"
cd ../sdk-typescript && npx vitest run test/unit/sessionPr.test.ts
```

Expected: an open binding gets its state and issues in one write with
`createdAt` untouched; merged bindings without a snapshot get one by-number
lookup and no list query, and neither query once snapshotted; a foreign-repo
binding never receives this repository's issues; a failed issue lookup still
refreshes states; the retired-generation guard covers the new lookup. The
session list prefers sidecar `issues` over the live entry; the bridge echoes
seeded issues and keeps them across a state-only re-bind; the SDK guard
accepts the three issue states and rejects `javascript:` issue urls.

## Group C: real gh against a real repository

From a checkout of a GitHub repository with `gh auth` configured, seed a
temporary runtime dir with one session bound to an open PR that references
an open issue, a merged PR that references a closed issue, and a foreign-repo
PR number, then call `refreshWorkspaceSessionPrStates` from the built cli
dist twice.

Expected: round one reports `updated: 2` and the sidecar carries
`state: "open"` / `state: "completed"` issues on the two real PRs while the
foreign entry is untouched; round two reports `updated: 0`; each round
finishes well inside the 10s gh timeout.

## Group D: Web Shell

```bash
cd packages/web-shell
npx vitest run client/components/sidebar/SessionDetailsTooltip.test.tsx client/components/sidebar/sessionSearch.test.ts
```

Manual: run `qwen serve`, open the Web Shell, create a PR from the Git dialog
with `Fixes #N` in the body, wait for the first sweep (60s after daemon
start, then every 5 minutes), hover the session row.

Expected: the tooltip lists `Issue #N` under the PR rows with a green
circle-dot icon (purple check once the issue is closed as completed, muted
slash for not planned), the link opens the issue, a stacked PR closing the
same issue lists it once, and typing `N` or `#N` in the sidebar search finds
the session. The session-row badge still shows only the PR.
