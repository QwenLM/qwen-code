# Explicit Agent Host replacement

[English](agent-host-replacement.md) | [简体中文](agent-host-replacement.zh-CN.md)

## Contract

Ordinary enrollment remains append-only. Names and working directories are Host-supplied attributes, never proof that two machines share an identity. An operator selects an existing Host and creates a single-use, 15-minute enrollment capability whose `supersedesHostId` is stored only in that workspace's registry. Registration cannot choose a different replacement target.

## Lifecycle

Successful replacement creates a new Host ID and secret, migrates every managed-host Agent binding from the selected ID to the new ID while retaining its provider and other Hosts, and revokes the old credential. Old running and cancelling runs fail with `agent_host_removed` and can be retried explicitly; runs already finishing retain their completed outcome. Old credentials and late results are rejected. Queued work remains bound to remote execution.

## Trust and persistence

Enrollment capabilities are minted through the selected trusted workspace's authenticated mutation route. Enrollment and heartbeat use the resolved workspace only, with no primary-runtime fallback. Unknown or removed targets, invalid or expired tokens and replay fail closed. Independent same-name Hosts are untouched.

The workspace lock serializes registration, binding migration and run settlement. Existing store files commit independently, without rollback. Before migration, the registry stages the new Host and records `replacementHostId` inside the capability. If a write fails, retrying the capability reuses that identity and rotates its secret; the old credential is revoked only after migration and settlement finish. A pending replacement can refresh its own link but cannot be displaced by ordinary enrollment or Host removal. Disk failures can temporarily leave both rows visible until this retry succeeds; no success is returned for an incomplete replacement.

The staged replacement is durable and deliberately outlives the 15-minute enrollment capability. Expiry rejects that command; it does not cancel the transaction or undo migrated bindings. Recovery errors identify the original Host by name and ID: select that Host in Runtimes, choose Replace, generate a fresh command, and run it on the replacement machine. Refresh rotates the capability while retaining the staged Host ID; the previous command remains invalid. The dialog labels this as resuming a replacement and offers a refreshed command after expiry. The old Host and staged Host cannot be removed until recovery completes; unrelated Host removal is unaffected. There is no automatic expiry cleanup or abort/rollback operation.

## Client and UI

A saved same-cwd credential with a replacement capability receives an explicit 409 enrollment handshake; ordinary heartbeat cannot consume that capability. Updated clients read legacy credentials to preserve identity and save credentials as `key.v2.json`. Older clients can delete only their original `key.json`, so mixed-version replacement cannot delete the new credential. Updated credential writes and conditional revocation cleanup also share a cross-process file lock. Writes compare the saved identity under that lock; stale startup cannot overwrite a newer credential, and an unchanged v2 credential is never rewritten. Replacement with a saved identity requires the updated Host client; ordinary enrollment and rejoining remain compatible. The UI offers replacement on a selected external runtime, describes the consequences and uses the existing join command. Replacement success requires both the old roster entry to disappear and a new online identity to appear. A refreshed recovery link returns its staged `replacementHostId`, so the UI can recognize that exact identity even when it was already listed offline. Remote-connect and unrelated collaboration architectures are outside this change.

## Acceptance

Verify ordinary independent enrollment, selected replacement, credential revocation, Agent binding migration, running/finishing settlement, late result rejection, one-use and workspace isolation, retry after a binding write failure, same-cwd join and protected credential cleanup. Verify the complete selected-Host flow on a real coordinator and Host through Web Shell, with sanitized screenshots and tmux captures. Controlled-provider evidence must be labeled separately from real-model evidence. Build, typecheck, focused regression tests and one consolidated review follow completed implementation.
