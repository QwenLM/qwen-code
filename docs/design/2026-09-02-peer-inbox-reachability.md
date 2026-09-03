# Keeping the peer inbox reachable

Date: 2026-09-02
Scope: `packages/core/src/ipc` (socket path resolution, inbox bind), and the
CLI surfaces that report a session's messaging state.

## Problem

A session with `agents.crossSessionMessaging` on registers itself and binds
a UNIX domain socket. Both steps can fail, and the failure was invisible:

1. **No fallback.** The socket directory was `$XDG_RUNTIME_DIR/qwen-socks/`
   and nothing else. In a rootless container or a user namespace that
   directory is often absent, owned by an unmapped uid, or read-only. The
   bind failed, the session started anyway, and the only symptom was other
   sessions reporting it absent — a diagnosis available only from the other
   side of the problem.
2. **No explanation.** The bind error went to a debug log that is off by
   default. `/peers` blamed either registration or the socket without
   knowing which, and pointed at `DEBUG=1`.
3. **A connection could be held open indefinitely.** The read timer was an
   idle timer that any byte reset, so a peer writing one byte at a time
   stayed under the 1 MiB frame cap and kept a descriptor for the life of
   the session. Recorded as a deferred finding when the inbox landed.
4. **Dead sockets accumulated.** A session killed with `SIGKILL` cannot
   unlink its own socket and nothing else did.
5. **A live session could be made unreachable by another one.** The bind
   unlinked whatever sat at its path first, justified by the path being
   keyed by PID: "if a live process were listening there, it would be this
   one." That holds only within one PID namespace. Two containers sharing a
   runtime directory, or a container sharing the host's, can produce two
   live sessions with the same PID; the second to start would unlink the
   first's socket, leaving it listening on an unreachable inode and
   believing it was fine.

## Design

**Candidate chain.** `resolvePeerSocketCandidates` returns every path this
process could bind, best first: `$XDG_RUNTIME_DIR/qwen-socks/`, then a
nonce-named private directory under the temp directory, then one under
`/tmp`. The bind walks the chain and gives up only when all of them fail.
Candidates over the `sun_path` limit are dropped before they are tried.

The nonce matters outside the runtime directory: a shared temp directory is
a place where another user can pre-create a fixed or uid-derived directory
name and lock us out, or where our own chmod could retarget a directory
they own. An unpredictable name avoids both, and costs nothing because
peers learn the address from the session registry rather than deriving it.

**Classified failure with a hint.** When every candidate fails the error is
mapped onto a cause a user can act on — not a directory, foreign owner,
permission, missing ancestor, path too long, sibling name too long, bind
failure, chmod failure — each with one line naming what to change. The
failure is kept in module state so two surfaces can show it: the session
prints it once at startup, and `/peers` repeats it instead of pointing at a
debug flag. A successful bind clears it.

**A deadline, not an idle timer.** A connection must complete a line within
30 s of connecting, and then within 30 s of its last complete line. Only a
whole line re-arms it, so byte-at-a-time dribbling no longer holds a
descriptor. A sender writes its frame and hangs up, so a legitimate
connection never approaches this.

**Sweep at bind time.** A starting session removes `<pid>.sock` files whose
PID is provably dead, and whole nonce-named directories holding nothing but
dead sockets. Conservative by construction: a live PID is left alone even
though it may have been recycled, because a leftover file costs bytes while
deleting a live session's socket costs its reachability. Bind time is the
natural moment — the directory only grows when a session dies.

**Probe before unlink; move aside, never take over.** The bind now dials
the path before clearing it. If something answers, that is a live inbox
belonging to another session, and this session binds `<pid>-<8 hex>.sock`
beside it instead. Only a socket that does not answer is unlinked. If
`listen()` still reports `EADDRINUSE` — the path was taken between the
probe and the listen — one retry at a sibling name settles it, and a second
failure is reported as a real bind failure. When a sibling name would
exceed `sun_path` the candidate fails as `sibling_too_long` — its own cause
and its own sentence, deliberately not `path_too_long`, because the
configured path itself fits and telling the user it is over a limit they can
measure is a claim they can disprove — rather than binding something
unusable, and the chain moves on.

A failure always names the path the user configured, never the sibling or
the nonce directory this process minted; the name actually attempted stays
in the errno detail.

## Trade-offs

- **A sibling address is not the PID-derived one.** Nothing in the codebase
  derives a peer's address from its PID — peers read `ipcPath` from the
  registry record — so this is invisible to senders. It does mean the
  filename is no longer a reliable index of which PID owns a socket, which
  is why the sweep parses the PID out of the prefix and matches the suffix
  shape exactly.
- **The probe costs a dial on every start.** It is a local connect against
  a path that is usually absent, and it buys the guarantee that starting a
  session never disconnects another one.
- **A live PID is never swept.** PID recycling means a live PID does not
  prove the socket is ours, so leftovers can survive until the directory is
  cleaned by the OS. Preferred over any chance of deleting a live inbox.
- **The startup notice is an error line in the transcript.** It is one line,
  once, only when messaging is on and the inbox failed. A session that
  looks enabled but is unreachable is worse.
- **30 s is arbitrary but generous.** It is three orders of magnitude above
  what a real send needs.

## Files

- `packages/core/src/ipc/socket-path.ts` — candidate chain, nonce
  directories, `sun_path` filtering.
- `packages/core/src/ipc/uds-inbox.ts` — failure causes and descriptions,
  candidate walk, probe-before-unlink and sibling binding, line deadline,
  both sweeps.
- `packages/core/src/ipc/uds-client.ts` — probe used by the sweeps and the
  bind.
- `packages/core/src/ipc/uds-inbox-bind-failures.test.ts` — the two bind
  failures no filesystem fixture can produce (a socket `chmod` that fails
  after `listen()` succeeded, and a `listen()` that fails at both names),
  kept apart so their module-level stubs stay off the real-socket suite.
- `packages/cli/src/peerMessaging/PeerMessagingContext.tsx` — failure
  context, kept apart from the inbox so a null inbox can be told from a
  failed one.
- `packages/cli/src/ui/startInteractiveUI.tsx` — captures the failure when
  the inbox resolves null with the feature on.
- `packages/cli/src/ui/AppContainer.tsx` — prints it once at startup.
- `packages/cli/src/ui/commands/peers-command.ts` — repeats it in `/peers`.
- `docs/users/features/commands.md` — user-facing description.
