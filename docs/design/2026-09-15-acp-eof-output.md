# Drain ACP output before EOF exit

[English](2026-09-15-acp-eof-output.md) | [简体中文](2026-09-15-acp-eof-output.zh-CN.md)

## Problem and evidence

The installed 0.23.3 ACP process can exit 0 after input EOF with an incomplete
`available_commands_update` frame. A controlled client paused reading for 101 ms
after the frame began, then read continuously until stdout ended. The actual
ACP process exited naturally with a 196,608-byte unterminated fragment; no
cleanup signal was sent. The launcher was bypassed using its installed Node
and CLI so the captured exit belonged to ACP itself. Earlier observations from
a harness that did not wait for complete stdout remain historical evidence only.

The SDK resolves `connection.closed` when input ends without draining its private
write queue. CLI cleanup subsequently calls `process.exit`. A successful Web
writer write is also insufficient: Node's `Writable.toWeb` can resolve below the
backpressure threshold before the native write callback. Output needs a native
finish barrier before successful process exit.

## Decision and boundaries

Give `runAcpAgent` a private output owner in `acp-output.ts`. It holds the writer
for `Writable.toWeb(process.stdout)` and gives NDJSON a gated byte stream. Normal
writes return the underlying write promise directly. After EOF cleanup, close
admission synchronously and close the underlying writer. This queues native
end/finish after frames already submitted to that writer; later frames never
enter stdout. Keep the close promise idempotent.

Await the writer's `closed` promise to retain original write/finish errors, even
when `close()` on an errored stream reports only an invalid-state error. Limit
the output drain to two seconds, matching the ordinary per-cleanup budget. On
timeout, reject and destroy the native output directly; do not wait for a Web
abort that can itself be queued behind the blocked write. Timers and writer
locks are released on settlement.

EOF cleanup failures and output failures both remain failures; aggregate them
when both occur. Keep signal handlers installed during the bounded drain. The
existing SIGTERM/SIGINT destroy-and-exit path retains its authority and is not
reported as an orderly output drain. No change to session disposal, available
command contents, SDK queues, signal deadlines or protocol fields.

The guarantee is complete frames already submitted to the output owner before
sealing, or a reported drain failure. It does not promise replies for every
inbound RPC still running after EOF, stop the SDK's internal queue, or deliver
data to a peer that has stopped reading permanently. This is a separate bugfix
from the #11866 behavior-preserving refactor.

## Verification

Use real Node Writable instances to test small writes below backpressure, large
pending writes, finish failures, original write errors, late frames, duplicate
close and a permanently stalled reader. Test EOF integration ordering, cleanup
failure preservation and overlap with signals. The independent test engineer
repeats the public client reproduction against the final bundle, waits for actual
ACP exit plus stdout end/close, and checks complete NDJSON and process/port cleanup.

Run affected tests, build, typecheck, bundle and lint, followed by two clean audits
and independent review. The original reproduction and any failed observations
stay in `.qwen/issues/issue-11866-acp-eof-output.md`.

## Final verification results

The implementation passed seven real-Writable tests and the affected ACP/CLI
tests, build, typecheck, lint and bundle checks. Two existing transport-mocked
tests needed to mock the new private output owner at the same seam; the initial
failing run and subsequent four passing tests are retained.
Two clean self-audits and independent review found no outstanding source defect.

The first final combined bundle passed both direct ACP EOF cases: EOF after the first
frame fragment, and EOF after the complete frame. Both actual ACP processes
exited naturally with code 0, a complete 1,058,795-byte command frame and all
524,288 fixture bytes. The two frames match after normalizing only session UUIDs
and exact temporary roots. The global baseline's catalog differs, so this is
not a claim of full catalog equality with the installed CLI.

A permanently paused reader produced actual ACP exit 1 and the original drain
timeout after 2,021 ms. A closed read pipe produced actual ACP exit 1 with the
original EPIPE after 16 ms. Raw harness failures remain recorded as expected
negative outcomes. Positive cases waited for stdout end/close; the EPIPE case
observed the expected closed reader. Independent checks found no owned process,
process group or listening port left behind. The 1,079-file bundle manifest was
unchanged before and after the eight combined E2E samples.

After restoring the installed Ink patch and rebuilding, all eight scenarios
met the same acceptance conditions again. Both normal EOF processes exited 0
with 1,062,289 stdout bytes, byte-identical to the earlier final output after
the same normalization. The stalled reader exited 1 with the original timeout
after 2,024 ms; the closed pipe exited 1 with EPIPE after 13 ms. The new
1,079-file manifest matched before and after, with no owned process or listener
remaining. `post-install-e2e-manifest.json` records this second artifact separately.

The reproducible EOF truncation is verified fixed within the stated output-owner
boundary. Historical observers that crashed or did not capture actual exit are
not retrospectively assigned a cause or exit code. Repository-wide validation
of the combined change is tracked in the
[completion design](2026-09-15-acp-bridge-completion.md).
