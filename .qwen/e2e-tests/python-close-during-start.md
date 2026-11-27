# Closing a Python query during startup

## Baseline

Issue #17493 records a real child from the official CLI 0.27.4 still alive after the query is closed during startup. A separate reproduction uses an actual local Python subprocess and reproduces the same interleaving. Further official CLI execution was blocked by automatic approval review; the repeatable verification launches only the local subprocess fixture.

## Behaviors to verify

1. Begin a public control call on a fresh query and yield while its subprocess creation is pending. Await close. The child must be reaped when close returns, and the control caller must observe a closed query.
2. Repeat with two concurrent close callers. Both must complete without leaving a live child. A subsequent close remains safe.
3. Close a query before any startup. A later public call must reject the closed query without launching a child.
4. Use a missing executable. Startup must retain its original failure, and closing afterward must complete without deadlocking.
5. Existing normal initialization, single-turn and streaming integration tests continue to work with the repository's local protocol subprocess.
6. An input generator's cleanup can close the already-closing query without deadlocking or losing the remainder of that cleanup.
7. Let the peer acknowledge initialization, then stop reading stdin. Send a message larger than the pipe buffer and confirm a write is still buffered before closing. Close must reap the child; subsequent control calls must report exactly `Query is closed`, even if the blocked input write fails during teardown.
8. A peer that exits non-zero before initialization must retain its original exit error, including its exit code, on repeated control calls. Repeated calls must not accumulate earlier tracebacks.
9. A peer that exits cleanly before replying to initialization must not receive the single-turn or streaming prompt. Both input tasks must complete without a broken-pipe error.
10. Let the peer send a permission request, wait for its callback to start, and exit cleanly. Before iteration ends, the callback must have finished cancellation and the incoming request registry must be empty, without requiring an explicit close first. Repeat with the callback awaiting close in its own cleanup; the callback, iteration, and surrounding query context must all complete.
11. Keep the peer alive after a permission request and have the callback await close before returning its result, without any prior cancellation. On Python 3.10, 3.11, and 3.12, close must return normally with the transport closed and child reaped; iteration and the surrounding query context must finish, and no incoming request may remain registered.
12. Repeat with a peer that ignores SIGTERM and remains alive after stdin closes, and set the permission callback timeout to 0.2 seconds. The callback must time out while teardown is pending. A subsequent external close must wait for teardown to reap the child; iteration and context exit must finish, and no incoming request may remain registered. Keep the ordinary peer as a control where the callback returns normally.

## Validation boundary

The regression uses actual process creation and termination, without mocking transport start or close. It does not contact a model service or assert that a model prompt ran after close in the original failure.
