# Linux CUA input recovery

Linux's semantic-input fallback currently treats failure after dispatch as if
the semantic route were unavailable. A native action can mutate the application
and then lose its D-Bus reply; the click tool subsequently sends a pixel click.
The same fallback exists for scrolling. Some click paths also ignore a false
AT-SPI acknowledgement and report success.

The reproduction uses the released 0.20.8 source: an action effect followed by
an error or the existing 25-second timeout produces two fixture effects, one
semantic and one pixel. A false acknowledgement with no effect still returns
"Clicked element". These are source-extraction reproductions with controlled
transport endpoints; they are not claims about the causes of every historical
zero-score task.

Port the macOS recovery principle into the existing Linux implementation:
fallback is possible before input dispatch, but a possible dispatch must stop
automatic replay. Track dispatch locally in each AT-SPI attempt, including
timeouts and partially completed scroll batches. Return an unconfirmed-input
error after false, failed, or timed-out acknowledgements. The caller must
observe before deciding whether to retry. Preserve safe pre-dispatch fallback,
exact target identity and the current foreground guard.

The existing Node REPL → Computer Use facade → native Linux driver topology,
processes, installation and permissions remain unchanged. No new public API,
service, global retry policy or provider-specific workaround is introduced.
The canonical fixed Computer Use skill remains the model guidance source.

The same dispatch boundary applies to text insertion and value replacement.
An uncertain insert must not fall through to a whole-field replacement, and a
rejected replacement must not fall through to an append. Successful writes
without readback remain unverified; they must not automatically emit a
foreground escalation that the shared core interprets as failed delivery.

Preserve editable text independently of the accessible label, including an
empty value when clearing a field. Compact observation rows omit duplicate
label/value text, default states and the primary activation action, while the
structured elements retain all actions. Keep nondefault state and secondary
actions visible so actionable differences survive revision comparison.

Pixel fallbacks retain the exact window and element identity. Intersect the
element bounds with that window and recompute the point after foreground
preparation, preventing oversized controls from targeting a sibling window.
GTK3 already supplies correct screen coordinates with client-side decorations;
avoid applying GTK4's shadow reconstruction to that case. Preserve and verify
the GTK4 path separately. Its X11 top-level Screen extents are window-local,
so correlate a multi-window GTK4 application only through titles that are
unique in both its native and accessibility window lists. Missing or duplicate
titles continue to refuse. Semantic primary activation applies only to an
unmodified single left click, preserving requested right and double clicks.

The owned Linux desktop also reproduced active-window and core-focus readiness
taking 644–734 ms. Allow one second for the existing focus confirmation loop,
which still returns immediately when ready and retries only preparation.
The action callback remains single-shot; this does not replay uncertain input
or establish the cause of historical benchmark focus failures.

Linux continues to use its existing exact-window public API. Port only the
applicable macOS batching guidance into the canonical skill: combine known
actions and emit final verification with cleanup in one cell, while observing
new dialogs and menus before acting.

Observation retries also share one native 25-second budget. Previously four
native attempts each received a fresh budget; the SDK's existing read-failure
retry could then repeat all four. Retry complete root-only or empty trees for
lazy toolkit registration, but return failed or incomplete reads immediately.
Preserve the native partial tree and diagnostic, or the X11 fallback when no
tree exists. Direct native consumers receive the first failure rather than
implicitly retrying it. The SDK keeps its existing single read retry.

## Validation

Reproduce the released code before editing. Verify true/false acknowledgement,
failure before dispatch, failure after an externally observed effect, timeout,
and partial scroll progress. Assert actual effect counts and absence of a
second actuator, alongside the model-visible error. Exercise element and
coordinate routes and preserve exact native identity on fallback. Then repeat
MCP → Node REPL → SDK input, focus restoration and screenshot tests on the
owned Linux VM, with independent application readback.

Compare right and double clicks against coordinate controls. Verify named text
set, insertion and clearing through both the observation and an independent
application state file. Exercise oversized controls, two windows from one
process, GTK3 decorations and GTK4 geometry separately. These GUI checks do not
prove transport-failure semantics: the GTK accessibility bridge acknowledges
its queued callback independently of that callback's return value.

Exercise complete and incomplete trees, unavailable and failed reads, cold
registration recovery, and budget exhaustion. Check both the native wrapper
and actual SDK facade with counted endpoints. Verify that the last valid
minimal tree survives retry exhaustion and each attempt receives only the
remaining budget. Measure actual model waits separately from allocated native
time budgets and provider latency.

Historical task terminal status, evaluator score, unique model responses,
uncached/cached input and output tokens are separate metrics. Fewer native
calls or text characters do not establish lower model cost. Paired real-task
evidence is required before claiming an efficiency or score improvement.
