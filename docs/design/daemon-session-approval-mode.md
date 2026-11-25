# Daemon Session Approval-Mode Persistence

[English](daemon-session-approval-mode.md) | [简体中文](daemon-session-approval-mode.zh-CN.md)

## Problem

Approval mode is runtime state on each daemon session's `Config`. When the last client detaches, the daemon may close the ACP child. A later cold load creates a fresh `Config` from workspace and CLI defaults, so a session that had switched to Full Access can silently return to another mode.

`persist: true` cannot solve this lifecycle problem because it intentionally changes the workspace default for every future session. The session needs its own durable state.

## Design

The transcript stores a last-wins `system/session_approval_mode` record with `{ mode, prePlanMode?, planExecutionMode? }`. Plan records preserve the non-Plan predecessor so a normal approved exit after cold restore returns to that mode. If Plan has a selected execution mode, approved exit uses that policy instead; the optional field preserves it across restore. Older records without it still restore. Readers select the last valid record on the active UUID chain independently of replay and compression selection. Rewind re-appends the live state on the new active branch.

An approval-mode listener on the canonical `Config` records successful runtime transitions. Derived agent configs do not publish changes. A session whose initial mode never changes is anchored immediately before its first durable prompt, Goal, or cron activity. Constructing a session and applying historical state during cold restore are read-only. An explicit mode change after construction, including an override supplied on creation, is recorded immediately so that it survives a cold load before the first prompt.

Cold load applies the restored approval state before constructing the live `Session`, so restore cannot trigger a new record. A synthetic exit from the startup Plan mode neither queues a manual-exit notice nor approves a workflow plan revision. Bare and safe startup modes ignore historical approval state. Current workspace trust is evaluated again through `Config.setApprovalMode`; a rejected privileged Plan predecessor falls back to the current safe mode. An explicit load or attach approval override is applied later and therefore wins. Workspace-settings reload retains the original file-derived mode as its comparison baseline, so an unchanged file cannot overwrite restored session state.

## Validation and Acceptance

Cold-loading or restarting a trusted session must recover its last mode without changing another session. Ordinary Plan recovery must preserve the predecessor used by a real approved exit; a separately selected Plan execution policy must also survive. An explicit load override must win now and on the next cold load. When current trust rejects historical privilege, an actual permission-sensitive operation must still require approval. Tests also cover read-only creation without a mode change, immediate recording of an explicit change, invalid tail records, pre-write failure retry, rewind, and fork/checkpoint selection.

## Compatibility and Failure Semantics

The HTTP request and response shapes do not change. `persisted` continues to mean that workspace settings were written. Session transcript writes are best-effort and use the existing recording-degraded reporting path; a disk failure does not reject a successful live mode change. A failed record attempt does not cache the new mode, allowing a later retry only if the recorder is still healthy; an append failure permanently degrades that recorder. Sessions recorded by older versions have no approval record and keep the current workspace or CLI default until their next real activity anchors it. If current trust rejects historical privilege, later activity records the safe mode; restoring trust does not automatically resurrect the old privileged mode.

Transient grants, pending permission requests, approval revisions, AUTO denial counters, temporary permission-rule changes, and derived config state are not persisted.
