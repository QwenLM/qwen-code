# Persist empty sessions before scheduled-task binding

## Problem

The scheduled-task REST route can bind an existing live, idle default session. A session created through `POST /session` without `sourceType` and without a prompt has no transcript yet. The binding succeeds and the durable task stores that session id, but after the client detaches and the daemon restarts, keepalive cannot resume the missing transcript. The task remains bound to an unavailable session.

Asking the user to send a message first leaks a persistence implementation detail into the product flow. Sending a synthetic prompt would be worse: it would call the model, run hooks, consume tokens, and add visible conversation content.

## Design

Before the REST path commits a task that explicitly names an existing session, the selected workspace bridge asks that session's child process to durably record its default source metadata. This reuses the existing `session_source` transcript record and `ChatRecordingService` writer lease. It creates a restorable transcript without a user message, model call, hook, or new transcript schema.

The bridge operation is intentionally narrow: it persists `sourceType: "default"` for a live session and succeeds only after the child acknowledges `persisted: true`. The route already permits only default-source sessions with no parent or source id, so other session kinds never reach it. The operation runs before the task-file lock; the existing eligibility check inside that lock remains the final authority. A generation check after persistence prevents a draining workspace generation from committing the task.

The route is selected-runtime scoped. It uses only the bridge captured for the task's resolved workspace and never falls back to the primary runtime. A missing bridge capability fails closed with `session_binding_unavailable`; a vanished session returns `session_not_found`; a failed durable write returns `session_persistence_failed`. If persistence succeeds but the later task write fails, the harmless default-source record remains because the session is caller-owned and deleting its transcript would be unsafe.

The trusted `cron_create` current-session path is unchanged. It runs inside an active prompt, whose transcript already exists, and a daemon-to-child persistence round trip from that private callback would introduce unnecessary re-entrancy risk. Omitted-session REST creation is also unchanged: it still creates a detached task-owned session with `sourceType: "scheduled_task"`.

## Compatibility and scope

- No task schema, REST request schema, capability flag, UI flow, or transcript record format changes.
- Existing populated sessions remain idempotent because recording an identical source returns success without another record.
- Ordinary sessions that are never explicitly bound are not persisted early.
- Already-orphaned tasks are not repaired automatically; after restart there is no safe way to distinguish a never-persisted session from an intentionally deleted or corrupt transcript.
- The persisted empty session can appear in session history. That is expected once the caller explicitly makes it the durable owner of a scheduled task.

## Verification

Unit tests cover bridge acknowledgement, failed persistence, REST ordering and failure mapping, and the unchanged cron-tool path. A real-process regression creates an empty source-less session, binds it, detaches, restarts the daemon, and verifies the same session is restored while no user/model message was generated. Existing default detached task creation and ordinary unbound session behavior remain unchanged.
