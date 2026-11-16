# Explicit Agent Host replacement

[English](agent-host-replacement.md) | [简体中文](agent-host-replacement.zh-CN.md)

## Contract

Ordinary enrollment remains append-only. Names and working directories are Host-supplied attributes, never proof that two machines share an identity. An operator selects an existing Host and creates a single-use, 15-minute enrollment capability whose `supersedesHostId` is stored only in that workspace's registry. Registration cannot choose a different replacement target.

## Lifecycle

Successful replacement creates a new Host ID and secret, migrates every managed-host Agent binding from the selected ID to the new ID while retaining its provider and other Hosts, and revokes the old credential. Old running and cancelling runs fail with `agent_host_removed` and can be retried explicitly; runs already finishing retain their completed outcome. Old credentials and late results are rejected. Queued work remains bound to remote execution.

## Trust and persistence

Enrollment capabilities are minted through the selected trusted workspace's authenticated mutation route. Enrollment and heartbeat use the resolved workspace only, with no primary-runtime fallback. Unknown or removed targets, invalid or expired tokens and replay fail closed. Independent same-name Hosts are untouched.

The workspace lock serializes registration, binding migration and run settlement. Existing store files commit independently, without rollback. Before migration, the registry stages the new Host and records `replacementHostId` inside the capability. If a write fails, retrying the capability reuses that identity and takes the secret the retrying Host proposes, or mints one for an older Host; the old credential is revoked only after migration and settlement finish. A pending replacement can refresh its own link but cannot be displaced by ordinary enrollment or Host removal. Disk failures can temporarily leave both rows visible until this retry succeeds; no success is returned for an incomplete replacement.

The staged replacement is durable and deliberately outlives the 15-minute enrollment capability. Expiry rejects that command; it does not cancel the transaction or undo migrated bindings. Recovery errors identify the original Host by name and ID: select that Host in Runtimes, choose Replace, generate a fresh command, and run it on the replacement machine. Refresh rotates the capability while retaining the staged Host ID; the previous command remains invalid. The dialog labels this as resuming a replacement and offers a refreshed command after expiry. The old Host and staged Host cannot be removed until recovery completes; unrelated Host removal is unaffected. There is no automatic expiry cleanup or abort/rollback operation.

## The enrollment secret

The Host makes its secret and saves it (`key.enrolling.json`, beside its credential, with hashes of the tokens it is sent with) before it enrolls, and sends it with the token. The coordinator keeps only its hash, as before, and mints one only for an older Host that sends none. The token is spent in the same step. A Host that never got the answer (a timeout, a dropped connection, a stopped daemon, a failed credential save) would otherwise stay enrolled with a secret nobody holds.

A retry sends the saved secret again, with the same token or a new one. The coordinator answers it as the enrollment it took: the same Host ID, no second Host, and a new token left unspent until it expires. The answer gives that Host's ID and public record to whoever holds its secret, which with that ID already authenticates as it. A Host that holds a credential and loses the answer to a Replace finishes it with the same command: when that command's token is refused but the credential still works, it sends the secret it sent with that token. A secret only other commands sent is not taken this way. The exceptions:

- A replacement staged under that identity is answered only through its capability, which finishes the binding migration.
- A Replace (its capability's token, expired or not) sent with a secret that an enrolled Host already holds is refused (409), and its capability stays unspent. Answering it as that Host would skip the Replace, and going through with that secret would leave two Hosts holding it. The Host then makes a new secret and sends the Replace again, so it replaces under an identity of its own. The Host that secret enrolled stays listed, offline, unless it is the Host being replaced. If that retry is refused outright (the capability expired, or its target is gone), the Replace did nothing, and the Host puts the earlier secret back, unless another enrollment saved one meanwhile. If that retry gets no definite answer (busy, dropped, or stopped), the earlier secret is not kept, and the Host it enrolled stays listed, offline, as after a Replace that went through.
- A Replace token the coordinator no longer holds (refreshed, superseded or used) is not recognized as one. Sent with an enrolled secret, it is answered as that Host, and the Replace is not done; the current Replace command does it.

The Host keeps the file only while it may hold an enrollment:

- It removes the file once the credential holds the secret.
- It removes the file when the coordinator refuses the enrollment outright: an invalid or expired token, or a request the store rejects. The secret enrolled nothing then, or only a staged replacement, which its capability finishes with a new one.
- A coordinator that could not complete the enrollment (busy or failing, 503) says nothing about an earlier attempt, so the file stays.
- It removes the file when the credential is revoked, before removing the credential, unless the file holds another secret; one it cannot read goes too. Enrolled again after a revocation, the secret would come back. If the file cannot be removed, the credential stays for the next attempt. A Host removed on the coordinator before this Host ever saved its credential is not seen as revoked here, so its secret can be enrolled again. That enrolls a new Host, not the removed one: the coordinator keeps only the secret's hash, and no other Host holds it.
- A file that cannot be read, or that this version did not write, stops the enrollment before the token is spent rather than being replaced.
- A secret that the saved credential already holds is not reused.

## Client and UI

A saved same-cwd credential with a replacement capability receives an explicit 409 enrollment handshake; ordinary heartbeat cannot consume that capability. Updated clients read legacy credentials to preserve identity and save credentials as `key.v2.json`. Older clients can delete only their original `key.json`, so mixed-version replacement cannot delete the new credential. Updated credential writes and conditional revocation cleanup also share a cross-process file lock. Writes compare the saved identity under that lock; stale startup cannot overwrite a newer credential, and an unchanged v2 credential is never rewritten. Replacement with a saved identity requires the updated Host client; ordinary enrollment and rejoining remain compatible. The UI offers replacement on a selected external runtime, describes the consequences and uses the existing join command. Replacement success requires both the old roster entry to disappear and a new online identity to appear. A refreshed recovery link returns its staged `replacementHostId`, so the UI can recognize that exact identity even when it was already listed offline. Remote-connect and unrelated collaboration architectures are outside this change.

## Acceptance

Verify ordinary independent enrollment, selected replacement, credential revocation, Agent binding migration, running/finishing settlement, late result rejection, one-use and workspace isolation, retry after a binding write failure, same-cwd join and protected credential cleanup. Verify the complete selected-Host flow on a real coordinator and Host through Web Shell, with sanitized screenshots and tmux captures. Controlled-provider evidence must be labeled separately from real-model evidence. Build, typecheck, focused regression tests and one consolidated review follow completed implementation.
