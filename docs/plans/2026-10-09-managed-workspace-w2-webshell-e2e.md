# W2 WebShell behavior E2E plan

[English](2026-10-09-managed-workspace-w2-webshell-e2e.md) | [简体中文](2026-10-09-managed-workspace-w2-webshell-e2e.zh-CN.md)

## Baseline and test layers

Global `qwen --version` and `qwen serve --help` identify the installed runtime but cannot prove Java WebShell behavior. Before this change a bound Session has no cwd control. Run focused tests from `packages/web-shell`. Keep browser API simulation, real Java/Hosted execution and live-model instruction adoption as separate evidence.

## Browser behavior

Use the identity-scoped Java provider fixture `packages/web-shell/client/e2e/fixtures/managed-workspace-w0d.html` on a dedicated Vite port. The browser suite may intercept BFF routes to control acknowledgements, operation states and response order. Save screenshots before, during and after the change; inspect scoped portal theme, keyboard focus and status announcements.

1. Omit cwdChange, omit identity scope, or use Daemon: no new entry. With supported provider, true capability and valid revision, open beside the current directory; default to its value and explain Workspace root and `.`.
2. Switch A→B, then `.` and a Unicode path with leading/trailing spaces. Assert the exact submitted string; empty and identical values cannot submit. Press Enter. A remains current until completed plus authoritative revision readback. Draft stays editable, Send and a second change are blocked, and closing the modal leaves the operation visible. History, loaded pagination and draft survive; no transcript refetch or synthetic chat message occurs.
3. Refuse invalid/missing/escaped/symlink paths, unavailable Workspace, forbidden actor, active task and approval. Explain the category without changing committed cwd. Revision conflict refreshes current context; a new request requires another user action. Change revision while the dialog is open and require explicit acknowledgement before submission.
4. Lose the submission ACK, reload and verify no automatic replay. Continue confirming must reuse the original request/key and yield the original operation. Reload a known operation and query automatically, including after capability revocation. A query permission refusal keeps the outcome uncertain and the intent intact.
5. Keep an accepted operation pending for an actual 30 seconds. Show result pending confirmation and retain the Send lock; Continue confirming queries the same operation. Exercise network/query failures and terminal failure separately. Initial sessionStorage failure sends zero POSTs; a later write failure must still retain the original semantic request/key for recovery.
6. Compete send/change, rapid double submission and two tabs. Within one tab the synchronous guard admits one request; across tabs the server arbitrates. Deliver old summaries after newer revisions and batch poll/event responses in reversed revision order: current cwd never regresses. Select another Session/account while requests are outstanding: abort old work and ignore late results; scoped recovery records never cross identities.

## Real Java and Hosted behavior

Run root `npm run build`, `npm run typecheck`, `npm run bundle`. Under JDK 21 run the existing `HostedPublicWorkspaceIT#workspaceCwdChangeSettlesThroughBothSurfaces` with `-Dnode.executable=<absolute Node path>` and `-Dqwen.cli.entry=<absolute dist/cli.js path>`. This starts real Spring/Broker/Harness/worker processes; verify completion, replay, context event/revision, root and path rejection, and discriminating later writes in B while A's original file remains. The local H2/deterministic-model case does not prove real MySQL parity, real filesystem Unicode/symlink cases or project-rule adoption.

## Release acceptance and compatibility

Before the BFF capable of returning true is merged/deployed, #13564 must pass same-Hosted-attachment A→B acceptance: the next Turn writes in B and uses B's QWEN.md/AGENTS.md rules, without recreating the Session. Also verify real filesystem Unicode/spaces/containment and busy/approval admission, React 18/19 keyboard/ref-sensitive dialog behavior and portal theme. Until then the frontend is safe to land against capability-less servers. No live rule test is claimed from a deterministic model.

## Verification record

Local artifacts and exact commands/results live in `.qwen/e2e-tests/`; report these results in the PR separately. At this revision the browser's ten groups, real H2 cwd process case and focused tests passed; seventeen React 18.3.1 hook/control tests also passed in jsdom with one isolated runtime. The live-model #13564 gate, MySQL family and React 18 browser execution remain unverified. Record further runs without replacing these limits with assumptions.
