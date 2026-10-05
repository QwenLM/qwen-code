# Shell process-group cancellation

[English](posix-shell-cancellation.md) | [简体中文](posix-shell-cancellation.zh-CN.md)

Status: implemented and regression-tested on Linux. Related issue: #13441.

## Problem and scope

An ordinary Linux Shell leader can exit after group SIGTERM while descendants
ignore the signal. Leader exit previously suppressed escalation and removed
cleanup ownership. This affects child-process and PTY execution. The repair
is confined to their Linux group cleanup; Windows and other POSIX paths keep
their existing behavior. Managed runtime cleanup is outside this change.

## Ownership and identity

Capture the original leader's Linux boot/start identity immediately after
spawn. Before TERM, record group members while an original identity still
matches the group and session. Before each destructive signal, require an
unchanged recorded member; accept new members only while that continuity holds.
Zombie identities can anchor continuity, but zombies are not running survivors.
Invalid PGIDs, unavailable identity and mismatches refuse destructive signals.
ESRCH ends ownership permanently. Permission errors do not prove termination.

These checks authenticate the observed group, rather than its numeric PGID
alone. Process enumeration and the identity-check-to-signal sequence are not
atomic; new-member and check-to-signal races remain. Metadata read failures
report incomplete cleanup, except ENOENT for a disappearing PID.

Cleanup confirmation assumes an ordinary, unfiltered `/proc` view of the
caller's PID namespace. Each inspection reads `/proc/self/mountinfo` and
requires one procfs root mounted at `/proc`, with `hidepid` absent, `0` or
`off`. Other modes are refused even with a `gid` exemption; unreadable,
missing or ambiguous mount metadata is an error. A terminal group ESRCH
does not depend on this view. This guard blocks known restricted-mount
views, but does not certify complete enumeration. PID submounts, other
filters, namespace mismatches and concurrent mount changes are unsupported.
Silent omission of an unrecorded live member beside a zombie witness can
otherwise produce false success. Restrictive `/proc` does not universally
fail closed. See [Linux procfs mount semantics](https://docs.kernel.org/filesystems/proc.html#mount-options).

Processes that move to another group/session are outside this repair. Other
POSIX systems need a stronger identity source before this guarded cleanup
can be enabled there.

## Cancellation and settlement

Publish one completion promise before TERM. Retain ownership after leader exit,
use a 200 ms grace timer budget, and dispatch KILL at most once for a surviving
authenticated group. Use a further 200 ms timer budget to confirm no running
members remain in the supported view. Both deadlines use a monotonic clock;
they are not hard wall-clock maxima. Synchronous `/proc` scans and scheduling
can overrun them, and transport draining adds latency. Return
incomplete cleanup through the existing result
`error` field; successful signal dispatch alone does not establish termination.

Synchronous service/app-exit cleanup consumes the same force action and cancels
grace escalation. Actual app exit cannot await confirmation, but the KILL
dispatch is synchronous. Natural completion releases ownership immediately;
background promotion transfers it without signals. Released owners and delayed
timers cannot signal the group again. The execution result remains single-fire.
Retain native exit evidence and the existing output-drain fences after cleanup;
detach foreground capture before settling an error while the leader is alive.

## Validation

The deterministic matrix covers identity replacement/unavailability, invalid
PGIDs, ESRCH, permission and other errors, and cancel/exit/force/timer races.
Mocked mount/visibility cases cover hidden unrecorded survivors, restricted
and ambiguous views, and a visibility change after TERM. They do not constitute
real `hidepid` runtime validation; no mount or credential changes were made.
Real Linux child-process and PTY fixtures cover surviving descendants, no
survivors, repeated cleanup, natural completion and promotion. Fixtures have
independent lifetime bounds, identity-guarded teardown and a dedicated subreaper.
Windows unit cases verify that its existing path is retained; macOS runtime
behavior and model/provider workflows are not validated by these tests.
