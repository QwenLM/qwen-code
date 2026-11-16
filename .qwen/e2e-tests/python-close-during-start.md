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

## Validation boundary

The regression uses actual process creation and termination, without mocking transport start or close. It does not contact a model service or assert that a model prompt ran after close in the original failure.
