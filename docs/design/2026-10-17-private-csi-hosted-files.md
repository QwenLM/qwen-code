# Private CSI Hosted file turns

[English](2026-10-17-private-csi-hosted-files.md) | [简体中文](2026-10-17-private-csi-hosted-files.zh-CN.md)

## Status and problem

This extraction follows merged #14081 on main `95b8d377a`. Its source is the
normal file-turn implementation in #13526 at `b0e9cfca44a156a766476fda9205267988403dc0`.
The existing private Session can run text turns. The original file worker,
retained file-history backend and native SQL admission already exist, but the
Hosted entry point does not connect them to model tool calls. Source-branch
test results do not qualify this extraction.

## Scope and constraints

Connect `read_file`, `write_file` and `edit` for the previously created original
READY private CSI Session. Keep writer generation 1, activation epoch 1, the
original Runtime binding and the existing private capability digest. Preserve
the text entry point, authentication, budget-directive refusal, diagnostics,
exact prompt retry and local-stop behavior from #14081.

No replacement writer, cold recovery, application cut/finalize, remote seal,
physical stop, unpublication, release, volume reuse or public CSI selection is
introduced. No schema migration or deployment change is needed. An uncertain
operation blocks the owner and retains its obligations rather than replaying
file mutations or discarding evidence.

## Execution and persistence

Bind the original worker's empty retained history after installing the original
activation. Persist its exact observation through the existing file-history
domain before exposing the attached Session. Before a file turn, produce the
normal Harness checkpoint and advertise only the three supported file tools.

Preserve assistant Parts, function IDs, part positions, exact input and tool
definition bytes. Reserve the complete accepted batch before dispatch. For
mutations, commit a preparation intent, request the original worker's backup
preparation, and persist its observation before the tool intent and dispatch
checkpoint authorize execution. Read-only calls need no mutation preparation.

Reject invalid, root-directory and oversized inputs before Runtime reservation.
Persist an explicit error result with each rejected original function ID; an
all-rejected batch can continue through the model without fabricated Runtime
work. The native reader validates the exact rejection reason against the original
call and full input size, accepts each refusal once, and keeps receipt proof
mandatory for admitted work. Mutation history references the latest committed
refusal message while preserving the original batch identity. Batch identity
compares the message ID, content reference and calls; refusal progress does not
change that identity or prevent the surviving calls from being reserved.
Normal reservation requests follow turn cancellation, while a lost or cancelled
prepare answer still requires one independent membership read bounded to five
seconds. A failed read or invalid reply preserves the original preparation or
cancellation error; it never authorizes another dispatch.
Check the size of the complete persisted history envelope, including the
reader-facing snapshot copy, before publishing it. Capacity refusal retains
uncertain work; it never truncates evidence or replays a mutation.

Execute through the authenticated Broker with the fixed original Runtime
Session. Retain each complete Broker outcome and the converted tool-result
message, then resolve the corresponding Harness wait. Before publishing a
receipt, validate the closed native result schema, including error metadata and
text/media Parts; reject supplied function responses or calls rather than
persisting an outcome the native reader cannot verify. Persist the post-work
file-history observation before returning results to the model. Mark results
consumed only after the model consumes them; settle the normal continuation
without releasing the Runtime. Oversized, partial or uncertain results block
the Session. Cancel and local stop do not prove that remote work never ran.

Commit the final assistant body together with the successful model-attempt event
before marking file results consumed. Keep the original streamed message ID and
Parts, and do not write a second assistant record. A failed model continuation
or uncertain final commit retains the unconsumed results and blocks the owner.

Assign Harness checkpoint command IDs and content digests inside the authority
queue, using the finalized state bytes and covered sequence. Activation renewal
may advance the journal between checkpoint construction and commit; the command
must describe the checkpoint actually published.

## Integration and ownership

The existing private routes remain authenticated loopback operator routes.
Their owner map names the original live Session. Broker requests must preserve
tenant, Workspace, Harness Session, Runtime Session, binding and generation;
the selected worker validates its installed context. No primary-runtime or
local-execution fallback is allowed.

The implementation adds the Hosted file-turn adapter, history client and
receipt writer beside the text producer. It extends the private text-turn
runner and attachment initialization only where needed. Shared model/Harness
interfaces change only if the normal producer requires them. Keep cumulative
recovery, retirement and general Hosted refactors out of this extraction.
Tests cover these consumers and the native SQL reader with actual producer
bytes, rather than accepting a separately invented journal shape.

## Verification and acceptance

Dry-run the globally installed CLI first. Verify the built CLI with owned HTTP
fixtures for inference, Broker and Store, including all three file calls,
precise input/result identities, mutation preparation, retry, refusal, stop and
cleanup. Label every fixture boundary; HTTP fixtures do not qualify a Linux
CSI worker or MySQL transactions.

Run root build, typecheck and bundle; affected CLI/Core unit tests; native Java
producer-to-SQL acceptance tests and module static checks where affected.
Transaction/concurrency changes require disposable MySQL 8.4 checks. Report
unavailable Linux, MySQL and deployed-chain checks separately. Review the whole
diff through two clean self-audit passes and an independent code review.

Acceptance requires a complete normal file turn, retained backups and results,
unchanged original ownership, exact retry without another mutation, refusal of
wrong identities or unsupported tools, and joined local cleanup. Physical
retirement and safe reuse remain separate work in #13526.

## Open questions

None for the bounded extraction. Any new requirement for recovery, installation
or physical release needs a separate design and review.
