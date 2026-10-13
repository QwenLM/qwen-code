# Cancelled turn recovery

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## Problem and scope

An explicitly cancelled daemon turn can resemble unfinished work after restart. Recovery must refuse work the user stopped while allowing a genuinely interrupted turn to continue. This change records cancellation intent in the existing terminal result and reuses the existing execution identity. Confirmation of legacy cancellation and UI wording belong to a follow-up change.

## Identity and terminal outcome

Client prompt IDs identify input; daemon prompt IDs identify executions. User records and existing turn attempts bind them on the active transcript branch. Full and selective restore resolve the same ownership independently of the replay window, including history before compression. A user cancellation requires a validated cancelled result with a finite cancellation timestamp, explicit user provenance and unambiguous ownership. Timestamped legacy cancellations or uncertain ownership remain unknown and refuse both automatic and direct continuation. Newer model input, attempts and terminal outcomes supersede an older boundary; completed local commands excluded from model history do not.

LlmClient owns the current execution ID and normalized terminal cancellation. Live settlement and cold restore use the same normalization. Successful input preparation accepts the existing invocation or model prompt ID; failed preparation cannot replace ownership. Settlement only updates its owning execution. A preserved pre-send input is accepted explicitly; admission-only cancellation and stale settlement cannot cancel unrelated work. Durable Retry/Continue attempts advance ownership while preserving the boundary until preparation. Compression, startup reminders and idle cleanup preserve the outcome. Explicit history replacement, rewind and clear invalidate it. Message arrays need no separate cancellation snapshots.

## Cancellation intent

Human Cancel, queued-input removal and active client Close carry user intent through existing cancellation metadata. Transport failures, deadlines, automatic teardown, disposal and ordinary SDK aborts carry interruption. A later human cancellation can upgrade an in-flight interruption; FIFO handshakes must finish before the next input starts. Only user intent writes the durable user marker. Recovery admission and execution both inspect the current terminal boundary. Invalid terminal payloads do not certify provenance; history gaps retain the degraded-history guard.

## Validation and acceptance

Use a real built daemon with an isolated loopback provider. Execute read_file, hold the next response, Cancel, kill/restart, reattach and Continue: require refusal and zero further provider requests. Omit Cancel and kill during the held response: require continuation and a completed terminal. Remove only the user provenance from the first transcript: the unknown legacy cancellation must also refuse continuation. Unit checks cover ownership, selective restore, compression, rollback, newer input, stale results and user cancellation upgrades.

## Remaining work

The follow-up adds explicit confirmation of unknown legacy cancellations and cancellation/interruption display wording. Untagged cron/steering ownership remains in #13502. Idle Close after an earlier interruption lacks a durable closed marker. Independent TUI paths are outside this recorded daemon scope. No transcript migration or release is included.
