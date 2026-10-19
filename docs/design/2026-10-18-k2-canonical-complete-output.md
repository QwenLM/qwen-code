# K2 canonical complete-output recovery acceptance

[English](2026-10-18-k2-canonical-complete-output.md) | [简体中文](2026-10-18-k2-canonical-complete-output.zh-CN.md)

## Status and problem

This document records current-schema C8 bounded process acceptance and its plan. Atomic final-output persistence and cold recovery are already implemented in the [primary K2 design](2026-10-09-k2-native-history-integration.md). Its historical bounded process result predates the canonical schema and current composition. That result does not establish current-schema acceptance. Current C6 reproduced a producer/verifier context-window metadata mismatch before its receipt cut. Its correction, merged module checks and fresh full process chain now pass as recorded in the paired canonical C6 document; the separate fresh C8 run and its independent audit now pass as recorded below.

C8 must recover a complete final assistant response that actually committed before its owner died and before result consumption. The existing marker-only attempt is insufficient. This increment adds process evidence unless a reproduced production defect requires a correction; it adds no recovery permission.

## Composition and boundaries

Use the same declared composition as [canonical C6](2026-10-18-k2-canonical-cold-process.md): current production provisioner, Broker and durable Store in a fixture JVM; actual packaged text Main and Hosted processes; an independent built production file worker; owned disposable MySQL 8.4 with all current migrations; and a local deterministic SSE model. Each text owner has an isolated home, original prompt identity, recorded boot ID and registered operating-system process identity.

Retain the explicit local Kubernetes API, placement, mount, proc-FD and Darwin boundaries. Bind the worker once to an already existing, verified reachable local non-loopback address. Use the default production HTTP transport and existing JDK proxy behavior without destination remapping or system network changes. This is not a native CSI mount, deployed Server, kernel confinement, actor-closure, physical retirement or volume-reuse acceptance.

Freeze source, compiled products, helper classes, the actual same-worktree Java SDK classpath, installed Node dependencies, JDK configuration and explicit runtime inputs before launch. Record the parent commit and working-tree patch when the source is uncommitted. Loaded Node files must belong to that pinned set; compare the full set after execution. These hashes qualify inputs without proving native immutability or closure of OS and dynamic-loader inputs.

## Fault cut

The original owner must make two real model requests. The first requests a finite Read/Write batch against a real owned file; both actual executions, original outcome references and result history must become settled. The second returns final assistant text with complete Parts and usage. The transparent Store proxy holds only the original successful upstream response after its actual SQL transaction commits and before delivery to Hosted.

The cut must be the original `hostedModelAttempt` / `*:output_committed` transaction containing exactly the adjacent `model.attempt` and `message.committed` events plus their commit marker. The attempt is `output_committed`; the assistant message names that same attempt. Preserve the complete original assistant resource, stream message identity, UUID, timestamp, model, parent, Parts, route, input checkpoint and usage references with their original bytes and digests. A single marker from the first tool-calling response must never trigger this cut.

At this cut, the checkpoint is `results_ready`, every original tool item is `settled` and unconsumed, file-history preparation is null, and no consumption or turn settlement exists. SIGKILL both registered original Main and Hosted processes, read back their exits, and retain the worker, database and files. Observe database time until both unmodified 60000 ms writer and activation leases naturally expire. Do not update expiration fields, inject a clock, seal, release, append a journal entry or create a native authority to advance the scenario.

## Recovery and conservation

Start one new actual packaged Main/Hosted pair with the identical original prompt ID and text. It must genuinely acquire writer generation 2, install activation epoch 2, read the original complete-output tail, and bypass the model runner. Then the production path consumes the original results once, records `turn_settled`, settles the original turn and returns ready for the next turn. Require a completed `turn_result` for the original prompt with `end_turn`.

Exactly two model requests and two original tool executions may exist across the whole scenario. Recovery must not create a third request, new model attempt, final assistant identity, tool intent, execution, receipt, tool repair message or file effect. The final checkpoint must be `before_model` with empty pending owners and null attempt, tools, Runtime and approval state while retaining the original prompt and turn identities.

Compare complete typed images of all 35 canonical tables at the cut, death, expiry and completion. Preserve the original journal prefix, immutable resources, result/grant bytes, execution rows, complete batch membership and worker request/effect counters. Preserve working and backup file bytes, device and inode. Qualify every changed resource verification timestamp against a captured successful same-scope GET and its actual returned/verified read receipt with database-time bounds; outstanding resource-read leases must be zero. Do not permit unrelated timestamp drift or fabricate timezone exceptions. New head, activation, read and consume/settlement state must match the actual successful production operations.

## Verification and cleanup

An independent test engineer runs the freshly frozen scenario after the C6 correction gates. Keep original HTTP requests and upstream responses, model requests, complete SQL images, journal/resources, database-clock samples, loaded-input records, process identities and death readbacks, final output and cleanup evidence. Independently audit those raw observations; a coordinator's PASS alone is insufficient. Preserve any failed attempt separately without converting it to a pass through a reporter change.

Stop only registered owned processes and endpoints, remove the owned database/user, data/socket and worker scratch tree, and read back process absence, refused connections and removed storage. A failure must retain its stage and original artifacts, distinguish observer/fixture failure from production refusal, and finish owned-resource cleanup before a new scope is prepared.

## Observed canonical result

On 2026-10-19, fresh owned scope `canonical-c8-41uvnl12` completed on parent `6717ce88820dc99982b14350ae777669a42b2907` plus the same five-file code patch as accepted C6 (SHA-256 `bc2a53e3debd17ed258e3eb333a41f0c69d8d659e6ed11cf698239da4480b035`). The actual original model2 atomic transaction returned upstream 200 with two events and three records; its 3,470 original record bytes and event/commit/content digests were independently recomputed. The earlier model1 marker-only transaction passed normally. At the held response, writer generation/epoch were 1/1, revision 24/sequence 25, checkpoint `results_ready`, and both original tools were settled and unconsumed. Both original Main/Hosted actually exited on SIGKILL. The original database, worker and files remained while 111 database-clock samples observed expiry of the unchanged 60-second leases.

The successor genuinely acquired generation 2 and installed epoch 2. Its only four new journal transactions installed activation, consumed results, recorded turn settlement and settled the turn; final revision/sequence are 28/30 with checkpoint `before_model`. Exactly two actual model requests remain. Original assistant Parts, usage, route/input-checkpoint references, stream UUID/parent/timestamp and full original resource bytes are preserved across commit, death, expiry and completion. Recovery creates no model attempt, assistant/delta, tool event or repair message. Both native execution rows, all sixteen original worker requests, all 438 observed file operations and the working/backup file bytes/device/inode remain exact. The final Main emits the original prompt's completed/end_turn result once.

Independent whole-image auditing verifies all 35 tables: thirty remain exact, with only the head, four journal rows, five new resources, eleven references and twenty-five additional read receipts changing through their actual producers. Eleven old resource rows change only verification fields, explained by captured successful reads. All 35 successful GETs match 35 RETURNED receipts under the actual database-time inequalities and original scope/token/body; no read lease remains outstanding. This is not a blanket timestamp allowance.

Before/after checks cover 128,634 files and 187 symlinks without drift; actual coordinator/worker/original/successor loaded files remain inside that closure, and all seven helpers match their archived inputs. The runtime Boot embeds the actual same-worktree SDK bytes. Independent cleanup confirms eleven scenario process identities and the separate preflight process absent, eight endpoints closed, twelve runtime paths removed and zero owned orphans. The dedicated database/user were dropped before normal MySQL shutdown and removal of its data/socket. The runner and five independent audit reports covering the complete-output cut, table images, reads, runtime/framing and cleanup pass. This accepts one bounded current-schema pre-consumption C8 case, not all later cuts or native K2.

## Acceptance and remaining work

A pass requires the genuine atomic complete-output cut, actual owner process deaths, natural lease expiry, generation-2/epoch-2 production recovery, exact original complete-output identity, no model3 or repeated effect, one consume/settle/idle chain and independently verified conservation and cleanup. Existing legacy marker-only refusals remain required; no captured payload may be rewritten to turn one into complete output.

Later consumed or settled cuts, exhaustive output media, provider authorship, Linux/cloud qualification, native actor confinement and installation, physical retirement and reuse remain separate work. This local scenario cannot establish full K2 completion.
