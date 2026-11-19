# Managed Web UI parity decisions, matrix corrections and local terminal

[English](2026-11-19-managed-web-ui-parity.md) | [简体中文](2026-11-19-managed-web-ui-parity.zh-CN.md)

- Status: implemented locally with real Managed terminal and focused verification complete; CI pending (2026-11-19)
- Baseline: `3f7b6088d9` (`origin/main`); issue claims were re-checked at this revision
- Parent trackers: #15084, with existing owners #13396 and #16546

## Problem statement and current state

Managed Web Shell does not explain many daemon-only surfaces. Their controls are hidden, so users cannot distinguish a tracked gap from a permanent product boundary. The capability matrix also contains stale rows: BTW and recap are marked absent despite mounted side-query routes, Session worktree rows use a blanket `no Managed worktrees` reason, and archived Session export is marked absent despite the shared export route.

The standalone Managed Web gateway relays terminal upgrades, but local `qwen serve --managed` does not enable the terminal deployment options or dispatch its WebSocket upgrade. The Java terminal implementation, one-time ticket, Runtime relay and Managed terminal panel already exist.

All four Session worktree tags exist at this baseline. Managed has Session-owned worktrees with create-at-session, inspect and cleanup, but not the daemon's ownership-transfer reset, post-create branch or work-carrying handoff operations. Recent Managed capabilities also refine two Table A claims: the workspace artifact library now provides cross-session cursor pages while progressive streaming remains absent, and eligible Sessions accept inline text/image attachments without providing daemon attachment references, chunk upload or listing.

## Goals

1. Give every Table A surface group a visible Managed status, a user-facing explanation and an explicit tracker.
2. Correct Table B only where current code supplies evidence, and pin those claims in tests.
3. Make the terminal work through local `qwen serve --managed` without adding a second WebSocket upgrade listener or weakening existing daemon authentication.

## Proposed changes

### Managed surface decisions

Add one **Managed capabilities** dialog to `ManagedSessionsPage`. The entry remains available for new and existing Sessions in both the full Web Shell and Managed-only gateway. It has the five Table A categories and all 35 surface groups from #17717.

Each item states the current Managed difference in English and Simplified Chinese and links its owner:

- Memory uses #13396.
- Agents, extension management, Hooks, Channels and scheduled tasks use #16546.
- The other 29 groups use #15084, including mid-turn **send now**. The latter explains that queued guidance is consumed automatically at safe model boundaries while the need for a separate affordance remains tracked.

All rows are **tracked**, not declarations of permanent exclusion. A maintainer can later move a row to a delivered or deliberately absent state in a separate reviewed decision. The inventory is client-side static data: it makes no daemon requests, creates no Sessions and does not infer product decisions from technical parity tags.

### Capability parity corrections

- Change `session_btw`, `session_btw_stream` and `session_recap` to `managed`, citing `surface:SIDE_QUERY_CREATE` or `surface:SIDE_QUERY_STREAM`. Remove those two newly cited labels from `MANAGED_ONLY_REPORTED`.
- `managed` records the mounted-route standing, not full integrated acceptance. Integrated acceptance of BTW and recap remains pending; preserve the [existing BTW and recap design](2026-11-09-managed-btw-recap.md) and its delivery-and-validation boundary rather than treating the rows as completed acceptance evidence.
- Keep `session_worktree_persistence_v1` absent: durable Managed Session worktrees do not satisfy the daemon's per-response `persisted-v1` attestation contract. Explain that distinction.
- Keep `session_worktree_reset_v1` absent and explain that cleanup is not the daemon reset/ownership-transfer operation.
- Keep `session_worktree_branch_v1` absent: an initial branch allocated during creation is not the post-create **create branch here** operation.
- Keep `session_worktree_handoff_v1` absent: recovery-draft handoff does not move a Session and its work between a worktree and the local checkout.
- Keep `workspace_git_worktrees` absent and explain the scope difference between repository-wide Git worktree management and Managed-owned Session worktrees.
- Change `workspace_archived_session_export` to `managed` with `surface:ITEM_LIST`; the existing export route authorizes archived readable Sessions and no separate archived route is required. Add an archived-export behavior test.

Tests pin the corrected standing and evidence token for each changed row. In particular, a test must prevent durable worktree storage from being mistaken for `persisted-v1` attestation.

### Local terminal wiring

Set both `qwen.managed-agent.runtime-broker.tool-measurements=true` and `qwen.managed-agent.runtime-broker.web-terminal=true` in the local launcher's `SPRING_APPLICATION_JSON`. Keep the Java global default off and keep the two options paired because terminal-capable Workers require measurements.

Move the standalone gateway's raw terminal relay into `managed-local-web.ts` and reuse it in both forms. Inject a Managed-terminal upgrade route from `server.ts` into the existing single ACP upgrade dispatcher. The route:

- matches only `/api/agent/web-shell/v1/sessions/{sessionId}/terminal` on the raw, unnormalized path;
- is primary-listener only and passes the existing Host and Origin checks;
- runs before daemon bearer verification because `qwen-bearer.<ticket>` belongs to Java's one-time terminal-ticket protocol, not the daemon token;
- forwards only the WebSocket handshake headers, query and initial bytes, never browser `Authorization`, Cookie, signing or identity headers;
- returns only the safe `qwen-ws` subprotocol and leaves every other upgrade path unchanged.

Because the terminal depends on this dispatcher, Managed local startup explicitly rejects `QWEN_SERVE_ACP_HTTP=0` instead of advertising an unreachable terminal. The ordinary daemon retains its existing ACP opt-out behavior.

The current Runtime resolver already treats ordinary, measured and terminal digests as compatible on the same local-mount profile and computes the summary hint from the Session's own READY, undrained terminal binding. Reuse those gates without changing Java Runtime code. The relay still performs its full admission; the summary capability remains a UI hint rather than an authorization decision.

### Documentation

Update the existing Managed terminal design pair and local Managed user guide pair to describe the implemented local entry, one-time ticket and local shell risk. A local terminal lets an authorized operator run arbitrary commands as the server OS account without per-command model approval; it is not a new model tool or permission mode.

## Design decisions and rationale

- **One inventory dialog instead of scattered disabled controls.** It covers hidden daemon surfaces consistently without duplicating 35 controls or introducing a general capability framework.
- **Tracking is not a product exclusion.** Unresolved surfaces stay visibly owned by #15084 until maintainers decide otherwise.
- **Reuse the gateway relay and the ACP dispatcher.** A second HTTP `upgrade` listener would race the ACP listener, which destroys unknown paths.
- **Ticket authentication stays separate from daemon authentication.** The existing HTTP ticket request is daemon-authenticated and signed by the local proxy; Java consumes the ticket during the upgrade.
- **No new terminal protocol or API shape.** Existing ticket DTOs, Runtime admission, panel and relay remain authoritative.

## Scope boundaries

- No implementation of the 35 missing daemon surfaces themselves.
- No permanent product exclusion beyond the differences already documented in each explanation.
- No new parity tags, OpenAPI route, model tool, approval bypass for model actions, terminal journal or artifact.
- No SSH, resident, extension or repository-wide worktree support.
- No change to ordinary daemon `/acp`, `/terminal`, Voice or CDP upgrade behavior.

## Files affected

- Managed UI: `ManagedSessionsPage.tsx`, a focused surface-decision inventory/dialog and collocated tests.
- Parity: `packages/cli/src/serve/capability-parity.ts` and its test; archived export coverage in `ManagedAgentApiContractTest`.
- Local terminal: `managed-local-serve.ts`, `managed-local-web.ts`, `managed-web-serve.ts`, `server.ts`, `acp-http/index.ts` and focused tests.
- Documentation: the existing terminal design and local Managed user guide pairs, plus this design and its E2E plan.

## Validation plan

1. Run focused CLI parity, local launcher, raw relay, gateway and real-front-door upgrade tests.
2. Run the Managed dialog and Sessions page tests, including all 35 groups, links, language variants and absence of extra backend calls.
3. Run focused Java archived-export, scope-compatibility and terminal-admission tests with JDK 21 and Checkstyle within the module's ten-minute local budget.
4. Build, typecheck and bundle the TypeScript workspace.
5. Exercise the local Managed terminal through `dist/cli.js`: capability, ticket, 101 upgrade, command echo, resize/replay, one-time ticket refusal, Host/Origin refusal and preservation of unrelated upgrade routes.
6. Open the Managed capabilities dialog in the browser, verify all categories and links, and confirm that opening it issues no new API requests.

## Acceptance criteria and open questions

The implementation is complete when all goals above have focused regression coverage and the local front door completes a real terminal upgrade. Full Java suites, MySQL profiles and CI remain separate required gates when applicable.

Open maintainer decisions are intentionally preserved in #15084: whether each currently tracked surface should be implemented, permanently excluded or reassigned to a more specific issue. No unresolved item is presented as settled by this change.
