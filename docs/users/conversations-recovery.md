# Conversations writer locks and recovery

Updated daemons can share Conversations and use different sessions at the same
time. A loaded session still has one writer. Live activation belongs only to
the exact publisher of the stable Live locator; losing Live publication does
not disable standalone conversations.

## A conversation will not open

`session_writer_conflict` means the writer fence prevented access. It can mean
another process has the conversation open, or that a residual lock cannot be
safely reclaimed. It is not proof that another writer is currently alive.
`session_writer_unavailable` means ownership could not be verified; retrying
does not authorize bypassing it. Archive and delete can return HTTP 200 with a
writer error for an individual session. Check every result item.

Close the conversation in the owning Qwen process normally, then use **Try
again** in the affected conversation. You can continue using other sessions.
Do not create a replacement conversation merely to make the error disappear.

After an ungraceful shutdown, a Linux reboot or a container restart into a new
PID namespace can leave an unsealed active writer record fenced indefinitely.
There may be no surviving owner to close. Follow
[Operator recovery for a residual lock](#operator-recovery-for-a-residual-lock)
instead of repeatedly retrying; this release does not reclaim across those
identity boundaries automatically.

If it persists, enable local debug logging (`QWEN_DEBUG_LOG_FILE=1`) when
starting the affected daemon and inspect the daemon and ACP child's diagnostics.
Lease-acquisition diagnostics include the session ID, error kind, and exact
`lockPath` resolved from that writer's runtime storage. Do not guess a lock path
from the primary workspace or a default home directory. Public HTTP/ACP errors
intentionally omit paths and ownership records. Keep diagnostic files private;
do not publish owner tokens or unredacted lock contents.

## Which state can recover automatically?

These rules apply to session writer leases. Legacy global owner records use
the more limited compatibility check described below.

- Normal close releases the lease. A certified sealed handoff is accepted only
  when its transcript proof is still valid.
- A dead active writer is reclaimable only when the existing identity checks
  establish that its process belongs to the same verified liveness domain.
- Live or stalled writers remain fenced. Killing a daemon is insufficient if
  its ACP writer child survives.
- Foreign or missing boot/process-namespace identity is not proof of death.
  An absent PID in your namespace does not prove a foreign writer exited.
- Malformed records, uncertain transcript identity, and residual transition
  claims fail closed. Elapsed time alone never authorizes takeover.

## Operator recovery for a residual lock

1. Identify the exact affected session and storage from local diagnostics.
   Preserve the failure log and a private backup of its transcript and lock
   artifacts. Record which binaries and hosts may access this storage.
2. Stop or otherwise fence **every possible writer**, including detached ACP
   children, other daemons, containers, namespaces, and machines sharing the
   filesystem. Verify the fence from the relevant host/namespace. If you cannot
   establish this, stop here and ask an operator who can.
3. Inspect the exact record and any associated claim/retired artifacts with a
   maintainer. Determine whether the last transcript and handoff proof are
   authoritative. Do not edit ownership identity fields to manufacture a match.
4. Only after writers are fenced and evidence is backed up, move individually
   verified residual artifacts to private recovery storage under operator
   supervision. Never recursively delete a lock directory or remove all locks.
5. Start one updated daemon, restore the original session, and verify its last
   recorded turn before appending. Retain the backups until continuity is
   confirmed. Bring other updated daemons back only after that check.

There is no force-unlock API or automatic cross-boot/TTL takeover in this
release. When safe ownership cannot be established, retain the fence.

## Coordinated upgrade and rollback

The backend cutover and Web Shell local-error/retry changes must ship in the
same release. This is **not a mixed-version rolling upgrade**: older daemons
can create a global owner after an updated daemon has already started.

Before upgrading, drain all old sessions and scheduled work, stop all old
daemons and their ACP children, preserve runtime data, and only then start the
updated binaries. An updated daemon encountering a live legacy owner returns
`503 conversation_runtime_in_use`; after that owner exits, retry without
restarting. Only an exactly revalidated stale legacy record is retired.
Malformed or unsafe legacy state requires operator investigation.

The legacy `conversations/runtime-owner.json` record carries a PID and nonce,
but no hostname, boot ID, or PID-namespace identity. Its compatibility check
can only test whether that PID exists in the updated daemon's own host and
PID namespace. It cannot detect an old writer that is alive elsewhere on shared
storage. This is another reason to fence every possible writer before starting
an updated daemon; the check does not make mixed-host or mixed-namespace
upgrades safe.

Before rollback, drain and fence every updated daemon and writer too. Inventory
active, sealed, claim, retired, and extended-schema records. Confirm the target
binary understands each retained schema and handoff state; never feed an
unsupported schema to an older writer or delete its protective record to make
rollback proceed. If compatibility cannot be established, keep writers stopped
and use maintainer-guided recovery or the coherent pre-upgrade backup. Never
restore an old transcript over later authoritative turns without explicitly
accounting for those turns.
