# Private CSI Hosted attachment and native text turns

[English](2026-10-13-private-csi-hosted-text.md) | [简体中文](2026-10-13-private-csi-hosted-text.zh-CN.md)

## Status and source

This is an independently reviewable feature extraction from #13526. Its base is
the private Session and SQL authority in #13996 at
`c0d930c066624988126e22aee2ee30417d45d391`. The initial text-only implementation
is taken from `06a1a868568683211986aa6cfa665309fce0e2e9`, checked against the
proposal's current `0a88d72f824d47a7bfe6ec8c0861b7a6a67b3b95`. Historical test
reports do not qualify this extraction. The source proposal is unchanged.

## Problem and scope

The base can create an original private CSI Session and validate native journal
commits, but has no Hosted caller for that Session. Ordinary Hosted create/load,
writer sealing and Runtime release have broader lifecycle semantics and must
not own this private Session.

This extraction attaches the previously created original Session to one
authenticated Hosted boot and runs native text turns. It retains writer
generation 1 and activation epoch 1. It does not introduce file execution,
replacement owners, cold recovery, retirement, physical release, public CSI
selection, Hooks or MCP. Unsupported routes remain closed.

## Components and ownership

| Component       | Change and consumer                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Startup         | Read `QWEN_HOSTED_CSI_SESSION_STORE_URL` once and validate the authenticated loopback Hosted profile, original Broker configuration and trusted Store origin.                                    |
| Private routes  | `POST /session/:id/internal-csi/attach`, `POST .../text` and `GET .../history` are live-session-owner scoped. Each operation rechecks the selected original Broker scope and HTTP writer.        |
| Native text     | A dedicated text-only adapter composes the existing model runner, native Harness/controller, record sink and delta stream. No configurable tool or recovery adapter is added.                    |
| Local stop      | The HTTP Store stops local renewal and joins already entered renewal without remote sealing. Both standalone app drain and host drain join private initialization, turns and activation renewal. |
| Java operator   | The existing private operator gains a bounded text command. It resolves the original SQL owner, negotiates the Hosted boot and sends attach/text with issued Session credentials.                |
| Broker readback | Reuse the base's private CSI acquire response with its persisted canonical cwd and isolation class. No Broker response change is needed.                                                         |

Private and ordinary Session maps are mutually exclusive, including UUID case
aliases. The private UUID is reserved before initialization yields. Failed or
uncertain initialization remains blocked and cannot be retried with a new owner.
Unknown, foreign, draining, stopped or blocked state never falls back to the
primary Runtime. Route authentication does not authorize other lifecycle work.

## Native behavior and failures

The Store URL allows HTTPS or loopback HTTP without URL credentials, query or
fragment. The original Runtime must already be READY; attachment does not warm
or release it. Admission pins tenant, workspace, Session, capability, binding
generation, workspace generation, isolation and canonical Linux cwd.

Configure the Store deployment base, for example `http://127.0.0.1:8081`;
the HTTP adapter appends `/internal/managed-session-store/v1` itself.

Genesis uses the existing private definition and root snapshot. The writer must
be generation 1 before genesis; the activation must be epoch 1 before exposure.
Text requests have exactly `promptId` and `text`, a canonical UUID and at most
16 KiB of nonblank UTF-8 text. A single active turn excludes another prompt.
Same-prompt exact retries return the original promise/result after current
admission; changed text conflicts. Native unsettled input prevents a new prompt. Turn-budget directives are rejected before native input admission because the inherited private SQL grammar does not support them.

The model runs without tool declarations using settled native history. Native
checkpoints, model attempts, deltas, complete assistant Parts, usage and Turn
settlement remain authoritative. The inherited SQL grammar accepts text and
thought-text Parts; unsupported signatures/media are refused without silently
removing fields. This extraction does not widen that grammar.
An ordinary settled model failure permits a
later prompt; uncertain native persistence blocks the owner. Private close,
activation replacement and release remain refused.

Stopping aborts the local model, stops admission and timers, and joins entered
initialization, turns and renewals. A locally aborted turn uses the existing native `error` settlement grammar, rather than introducing a cancellation outcome. It sends no remote writer seal, Runtime
release or deletion. The Java request cancels its HTTP exchange when its local
30-second budget expires, including incomplete response bodies; this does not
prove remote work stopped.

The inherited private SQL proof is limited to 4096 history transactions, including activation renewal and model deltas. With a 20-second renewal interval, an idle attachment alone reaches that bound in roughly 22 hours; active turns may reach it sooner. Exhaustion blocks the owner without sealing or releasing it. Compaction and owner recovery remain follow-up work.

## Validation and acceptance

Record the globally installed CLI baseline before implementation. Verify the
extracted packaged CLI's authenticated private routes, two native text turns,
complete Parts/usage and history, exact retry, changed-prompt conflicts,
ownership aliases, malformed requests, wrong credentials/boot/scope and failure
stickiness. A blocked renewal must delay local stop without remote seal/release.
Run affected Core/CLI/Java tests, build, typecheck, bundle and scoped static
checks, followed by two clean full-diff audits and independent review.

Use isolated deterministic inference and explicit Runtime/SQL fixtures where a
real Kubernetes owner is unavailable, and report those seams separately from
actual SQL integration. Tests do not qualify Linux CSI, target-cluster
deployment, physical retirement or safe reuse. This cross-package feature
requires maintainer architecture review.

## Integration constraints and follow-up

The PR is stacked on #13996 so its review diff contains only this extraction.
After that dependency lands, rebase on actual main and rerun the gates. The
32-table fresh-database proposal #14069 remains a separate schema change; do not
copy its SQL or allocate migrations here. The next extraction is the finite
native Read/Write/Edit and complete result-consumption chain, followed by
separately reviewed recovery and retirement. There are no new product decisions
or public API changes in this text-only block.
