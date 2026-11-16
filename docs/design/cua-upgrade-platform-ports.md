# Computer Use platform ports (2026-10)

[English](cua-upgrade-platform-ports.md) | [简体中文](cua-upgrade-platform-ports.zh-CN.md)

This is the implementation ledger for the approved [upgrade design](./cua-upgrade-2026-10.md). Code adapted from trycua/cua through `cua-driver-rs-v0.35.4` is MIT licensed, Copyright (c) 2025 Cua AI. Only the native driver library is a port source. The upstream bench package and its license are not included.

## Dispatch contract

App input resolves an exact application/window inside the driver. macOS uses accessibility and process-directed events; there is no automatic global foreground fallback. Windows and Linux may try the foreground rung once, exclusively after a native `background_unavailable` error with `sent:false`. An actuator error after a possible dispatch never replays input. Explicit desktop input is a separate foreground surface.

Foreground transactions observe physical input without consuming it. They stop remaining input on detection, preserve an external foreground C, and restore prior A only while the transaction still owns B. Windows drains the target input queue before restoring; text checks the target between UTF-16 units. Linux confirms both EWMH activation and core input focus before XTest.

Success acknowledges dispatch, not application effects. Input calls do not wait for screenshot changes. The next observation supplies effect evidence. A held press and a multi-click gesture retain only the timing required to deliver the gesture.

## macOS

| Upstream reference         | Adaptation                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #4943                      | Do not send A a synthetic deactivation notice when directing focus to B.                                                                                                                                     |
| #4943, #4955, #5091, #5129 | Key-focus protection shares the existing per-process `app_focus` observer; bounded tail/order correction and intentional-focus epochs prevent competing observers.                                           |
| #4976                      | Physical mouse/modifier activity grants the user's switch priority. The existing activation guard checks the same physical-input state.                                                                      |
| #5051                      | Directed mouse events explicitly set modifier flags, including the empty set.                                                                                                                                |
| #5057                      | Existing-file saves and Finder item renames use bounded Apple Events and readback. Arguments are passed as script arguments, not concatenated into AppleScript. Automation consent follows normal macOS TCC. |
| Popup selection            | Open a popup, select a unique matching option through AX, close a menu opened by this call on refusal. Safari's existing DOM fallback remains restricted to the actual foreground document.                  |
| Text insertion             | ASCII uses directed events. Non-ASCII requires a focused editable element and AX selected-text support; expected insertion is read back. No keyboard replay after an uncertain AX write.                     |
| Document model             | A verified AX write to a document-backed AppKit field registers an edit through a directed, net-zero editing shim; refusal is reported if registration cannot be verified.                                   |

Background drag refuses before dispatch. Sliders use `setValue`. Paste keeps the clipboard restoration transaction. The old fixed one-second post-action wait is removed. Neither AX acknowledgement nor event delivery alone is reported as a confirmed effect.

P7 controlled-provider tests of the complete native tool modules reproduced
raw double-click and right-click replay after an advertised AXOpen/AXShowMenu
applied an effect but returned an error. Once
either AX action is attempted, its error now returns a normal sent/unconfirmed
acknowledgement and warning; no pointer route follows. Successful semantic
actions and a pointer route selected because no action is advertised retain
their behavior. These AX acknowledgements explicitly identify background
delivery, even when the raw request selected foreground, because this semantic
branch performs no foreground transaction. Independent controlled tests execute
both complete native tool modules and the actual core public projection: all
six double-click and four right-click cases pass, with three uncertain cases
remaining unverifiable/accessibility and preserving their warning. Default App
early forwarding is a control; these tests do not demonstrate an App defect or
an actual macOS AX server returning an error after an effect.

## Windows

| Upstream reference   | Adaptation                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4500                | Attach to the actual target input queue and use a sentinel read to bound queue draining before restoration.                                                                                                                                                                   |
| #4901                | Check foreground ownership and physical input between UTF-16 units; stop after a stalled unit without replay.                                                                                                                                                                 |
| #3671                | A timed-out UIA point action is distinct from a preflight absence of a suitable pattern, so an uncertain action cannot become a second coordinate click.                                                                                                                      |
| #4774                | Native combo selection uses the control's selection and notification messages and verifies the selected value.                                                                                                                                                                |
| Tk                   | Refuse the unsupported background pointer rung before input; the shared App dispatcher may then use foreground once.                                                                                                                                                          |
| Extended keys        | Left/right Windows keys carry the extended-key flag.                                                                                                                                                                                                                          |
| Worker IPC           | Bound worker response reading; a timeout says input may have been sent. UIAccess routing is explicitly opt-in.                                                                                                                                                                |
| Standard-user launch | The elevated daemon derives and verifies a Medium token from its own token with administrator membership deny-only. No other process token is opened or borrowed. Direct executable and shell-helper launches use that token; failures refuse rather than launching elevated. |

The normal installer/UAC flow is retained. Cross-compilation is build evidence only; it does not prove a normal interactive Windows desktop, UAC behavior, token facts at runtime, or shared-desktop interference.

## Linux

Native Wayland support, helpers, dependencies and installer payloads are removed. X11 and XWayland X11 applications share the same X11 implementation. A compositor-native Wayland surface is unsupported.

| Upstream reference | Adaptation / existing equivalent                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3882              | MPX pointer/keyboard dispatch, toolkit-aware refusal, occlusion and focus guards, no input shields. Existing fork exact-window checks remain.                                                                                                                                                                                     |
| #3761              | Flush/check key press before hold timing; unconditional final server round-trip before closing a short-lived connection. A later P7 reproduction shows that server delivery alone is insufficient for temporary keymaps; the client-queue fix below remains under validation.                                                     |
| #3762              | Check pointer presses/releases, keep gesture timing, release a queued button/modifiers after an error.                                                                                                                                                                                                                            |
| #3864              | Preserve the fork's exact observed bus/object click identities and per-window snapshot validation. Session-owned MPX device persistence comes from the MPX umbrella rather than this identity patch.                                                                                                                              |
| #3618              | Modified foreground drag brackets the gesture with real modifier transitions and cleanup. Unsupported modified background drag refuses before dispatch.                                                                                                                                                                           |
| #4248              | The new App contract has no post-action effect classifier: closing B's dialog cannot be mislabeled a no-op because the WM parks focus. Existing exact-target foreground restoration preserves C and does not infer confirmation from unattributed popups. The upstream screenshot/window-change wait is intentionally not copied. |
| #4188              | Exclude application/frame/window shells from coordinate AX activation; recognize both NUL-separated and space-joined Chromium helper command lines.                                                                                                                                                                               |
| #5139, #5158       | Unicode keysyms and full-character preflight; reserve/remap spare keycodes before the first event; serialize temporary keymap changes. No silently skipped characters.                                                                                                                                                            |
| #3601              | Master ownership includes boot, PID namespace, UID and process start identity. Reap only stale devices proven to belong to this driver family.                                                                                                                                                                                    |
| #2888              | Conservatively refuse MPX on KDE where device hotplug may reconfigure physical input. No automatic permission changes to `/dev/uinput`.                                                                                                                                                                                           |
| #5070              | Background keyboard refusal names a missing AT-SPI bus and its normal setup path; the diagnostic bus probe is bounded.                                                                                                                                                                                                            |
| #4903              | Remove AT-SPI P2P feature/peer calls; use one registered accessibility connection.                                                                                                                                                                                                                                                |
| #4984              | Rebase tree bounds only against a valid complete screen frame; reject incomplete/zero-size frame geometry.                                                                                                                                                                                                                        |
| #5074              | Wake an AT-SPI application with attributes before its first child walk.                                                                                                                                                                                                                                                           |
| #4375              | First semantic walk budget is two seconds; later walks one second. No generic full-tree retry for an incomplete observation.                                                                                                                                                                                                      |
| GTK combo          | `Selection.SelectChild` picks a unique option and its selected-child name is read back. No focus/foreground change for selection.                                                                                                                                                                                                 |
| #4292              | Preserve text content separately from labels; prefer numeric Value for numeric controls and do not read password Text.                                                                                                                                                                                                            |
| #3758              | Decode DirectColor screenshots with the X colormap rather than treating them as TrueColor masks.                                                                                                                                                                                                                                  |
| #4281              | A successful kill waits for actual process exit; zombies count as exited.                                                                                                                                                                                                                                                         |
| #3814              | A delivered exact-window frame explicitly reports `screenshot_frame_valid:true`.                                                                                                                                                                                                                                                  |
| #4529              | Prepare overlays unmapped with empty input/bounding shapes; map only while painting visible content and unmap idle frames.                                                                                                                                                                                                        |
| #4715              | Non-Linux stub registry no longer advertises the removed screenshot tool; portable menu schemas do not pass through cursor-only schema assertions.                                                                                                                                                                                |
| #3658              | Enter/Return/KP/Numpad aliases share the terminal key gate and key mapping.                                                                                                                                                                                                                                                       |
| #3778              | Existing opt-in native browser tools share the session cursor registry; inactive tabs do not move the visible cursor. This does not add upstream browser tools to the default surface or change the repository Browser SDK.                                                                                                       |

Fork repairs also preserve per-window screenshot scaling, do not scale an omitted mouse-up position twice, restrict Qt synthetic FocusIn to Qt5, condition FocusOut on actual core focus ownership, and classify Chromium only when a route needs the information.

### P7 Linux temporary keymap lifetime

Both the candidate and upstream lose remapped Unicode characters when an owned
GTK application's event loop is paused for three seconds: the server delivers
the keycodes, the driver restores the map, and the client later translates them
as NoSymbol. This is independently reproduced in nested Xorg, separate from the
unstable main GNOME session.

The candidate now prepares an X11 client-queue acknowledgement before changing
any mapping or sending input. Only operations needing a spare keycode pay this
cost. The target or a same-X-client ancestor must advertise `_NET_WM_PING`;
another connection in the same process does not qualify. XTest also checks the
focused client before each character and before/after the acknowledgement.
After dispatch, the exact nonce echo on the root window releases the temporary
maps. A five-second timeout restores the maps and returns a normal
sent-but-unconfirmed acknowledgement, with no replay. A detected focus change
during partial typing still stops remaining input with an error. Missing protocol
support refuses before input. The existing ASCII path retains its server
round-trip, with no added ping. Sparse pointer modifier maps refuse before input
because a borrowed keycode does not establish a real modifier mapping.

MPX additionally requires raw-key server-delivery confirmation before sending
the client ping. A controlled reproduction found that the last-key predicate
accepted an earlier repeated release after only two of six planned events. The
revised predicate requires every transition in order from the actual virtual
slave, including repeated keys and Shift. A legacy zero source ID is accepted
only if the event's device ID is that exact slave, never the shared master.
Unexpected same-source transitions leave delivery unconfirmed. A retained
virtual keyboard with unconfirmed input refuses the next request before
mapping, focus or dispatch; normal session cleanup removes that state with the
device. Device warm-up must also confirm its full batch, before the planner
can borrow a keycode. The existing keymap-to-MPX lock order is preserved.
Independent controlled lifecycle cases pass 10/10, matcher cases 13/13 and
actual Linux unit tests 16/16 after the warm-up preflight below. Kernel backlog
and physical-device validation remain pending; the controlled tests replace OS
boundaries with stubs.
Before warm-up, XKB must identify the actual slave and prove X248 has no symbol
in any group or level. An occupied, invalid or unreadable mapping refuses with
zero emissions and retains the pending state. The fixed keycode is never
temporarily remapped to make this check pass. Independent checks cover 20
mapping/query cases and three retained-pending entrypoint cases; C header and
Rust layout measurements agree. The real read-only Xephyr slave's empty-group
mapping is a shape control, not evidence for a new uinput device.
No focus grab, input shield, clipboard change, permanent keymap or new helper
process is introduced. GTK and Chrome probes establish the queue mechanism;
Chrome's echo precedes DOM input completion, so it is explicitly not semantic
success. Native-v5b GTK responsive, three-second blocked, timeout, wrong-nonce
and unsupported-protocol cases pass their respective effect/refusal/uncertainty
checks. Chrome's responsive/blocked/timeout mechanism checks use v5a; v5b changes
only uncertainty reporting, which is tested separately. Physical MPX remains
unverified.

## P7: upstream correctness closure

### Ordinary macOS AX walk budget (G31 / upstream #3882)

The ordinary raw and default App observation currently limit tree depth and
node count, but only the recorder has a time budget. Adapt the upstream
one-second node-walk budget to the ordinary observation entry. Start it at the
first admitted, nonduplicate node, after window selection and readiness work.
Keep the separate Chromium readiness and AppKit launch budgets, the existing
native messaging timeout, and the outer observation timeout. This cooperative
limit cannot cancel a blocked native read or guarantee a one-second total call.

A deliberate time cutoff must preserve the completed prefix and mark the
observation truncated and incomplete. Successful attempted reads retain
`read_complete`, matching the existing node/depth-cap semantics; an actual AX
read failure still clears it. Bounded revisions return a full replacement when
the prefix changes, so missing rows are not deletion evidence. Raw tokens must
remain bound to their own immutable captured objects across later captures.
Verify these consumers with actual walker results before accepting the fix.

The legacy node-only walker and recording's absolute deadline keep their
existing behavior. No public timeout parameter, new output field, worker or
action retry is introduced. A finite slow-node reproduction and setup-delay
control precede implementation; native latency remains a separate acceptance
boundary.

### Windows installer parent protection (G32 / upstream #4398)

The release installer's shared daemon cleanup can kill the driver process that
launched `update --apply`, including its installer child, and can misclassify
that protected parent as a stale daemon. The independent reproduction executes
the exact PowerShell functions with all process, task and pipe boundaries
stubbed; no real process or scheduled task is stopped.

Adapt the upstream live ancestor walk, rejecting a reused parent PID whose
creation time is later than its child's. Cleanup targets only non-ancestor
driver PIDs and excludes ancestors from the survivor/repair list. If a driver
ancestor is present, skip the task-wide `/End` operation as well: a PID filter
cannot protect an ancestor from Task Scheduler termination. An unavailable
ancestor query stops cleanup before any termination. Legacy migration uses
the same helper instead of a second image-name tree-kill implementation.
The separate `-local` installer identity is unchanged.

Validate ancestor and unrelated-process cases, stale reporting, PID reuse,
cycles, query errors and legacy delegation through isolated command stubs.
The regression script gains an explicit unit-only entry that exits before
builds and real Task Scheduler tests. This source change neither registers
nor changes a scheduled task or Windows permissions.

### Windows autostart failure reporting (G33 / upstream #3180 and #4284)

Replace a task with `Register-ScheduledTask -Force` instead of deleting it
first. Elevation must return a failure when UAC is cancelled, no process is
returned or the child has no exit code; otherwise forward the child's actual
exit code. Quote the executable as a literal PowerShell argument. Reuse the
existing task-status query to verify successful registration; an unavailable
query reports that registration could not be verified, rather than printing
an unconditional success. Cancelled or unverified elevation is not retried
automatically.

Both Windows installers should print registration success only after their
registration call succeeds. An isolated release install selected by
`CUA_DRIVER_RS_HOME` or `CUA_DRIVER_RS_INSTALL_DIR` leaves the shared daemon and
autostart task alone unless
`-AutoStart` was explicitly requested. This guard also surrounds the shared
daemon cleanup before registration; guarding only the closing autostart block
would still terminate the ordinary installation's daemon. Default installation
and the separate local product identity retain their existing routing.

Independent before/after tests execute the actual PowerShell payloads and
installer blocks against task/UAC/cleanup stubs. They must cover cancellation,
null/failed children, preservation of an existing task on registration failure,
accurate summaries and isolated/default/explicit parameter combinations. These
tests do not perform UAC, task registration or a live installation. Separately authorized native task and owned installation lifecycle tests have since run; their identities and limits are recorded in the current acceptance appendix.

### macOS background window order (T04)

The on-screen CGWindow query is authoritative for visible stacking order;
the all-window query can disagree even for windows it marks on-screen.
Real desktop diagnostics also found that reactivating the already-frontmost
application can return success after a second without restoring its order.
The guard will instead request AXRaise only on that application's current
AXFocusedWindow, after checking its PID and exact visible layer-0 window ID.
WindowServer must still name the same front application, and recent hardware
mouse/modifier activity prevents restoration. AX calls use a 100 ms messaging
timeout, references remain owned for the call, and the existing bounded watch
limits remain. This changes neither key focus nor the background action's
dispatch path. API acceptance alone is not proof of restored order.

A single owned-window primitive probe restored visible order about 23 ms
after AXRaise while preserving all owned synthetic typing. Three production fix-2 rounds
eliminated sustained covering but retained 99.4, 200.5 and 192.8 ms of transient
covering, so the zero-interference gate remains open. All owned synthetic typing stayed
in A; popup/context, intentional activation and explicit foreground regressions
passed. A subsequent strict-ID diagnostic observed the rise after the requested
mouse-down, before mouse-up; the activation/warm-up phase showed no rise in that
run. This supports further investigation of requested pointer delivery, not
removing the warm-up on speculation. The earlier activation-based fix failed
and remains recorded.

One later preparation-only cell skipped both requested events and observed no
covering; unchanged guards and sampling still limit that negative result. A
separate task-only cell retained preparation and changed only the requested
pair to one public CGEventPostToPid publisher per event. Exact-source receipt,
native field-editor state and forced final AX focus verified the intended click,
but SentinelA still observed 194.110 ms of covering; the independent sampled
WindowServer-order interval was 196.695 ms. This transport change is not a
demonstrated remedy and was not applied to production. All ten synthetic
canaries reached A, but only one was sent within the click call and none during
the observed covering interval. This does not establish human-input safety
during covering or general zero interference.

### Off-Space window observation (G17 / upstream #4996)

Add the upstream single-window SkyLight backing-store capture to the shared
capture layer. A known off-Space target tries it before the public SCK/shell
chain; current-Space and unknown targets retain public-first ordering. Resolve
the private symbol dynamically, retain the returned image independently of its
owning CFArray, reject empty or fully transparent images, and preserve the
existing image dimension limits and PNG conversion. This adds no process,
permission, activation or Space switch.

The private route must validate the existing WindowCaptureIdentity before and
after capture, and refuse attached-window or unresolved attachment geometry.
It shares the existing one-worker gate and the three-second native capture
budget with SCK; an unreturned native call retains the permit, including after
the caller times out. Public shell compatibility retains its current behavior.
All consumers continue through the same capture function. A backing-store image
can be stale, particularly for off-Space Chromium, so raw and default App
observations must carry that limitation rather than imply a new frame proves
an action's effect.

Verification first executes the current entry point with controlled native
boundaries, then checks routing, identity changes, attachment refusal, CF
ownership, transparent pixels and worker limits. Those checks do not replace
real off-Space capture or the separate exact AX remote-token recovery work.

### Exact omitted AXWindow recovery (G17 / upstream #4068, #4085, #4509)

After public window, focus/main and attached-sheet discovery fail, a bounded
remote-token probe may recover the requested AXWindow. It requires a current
same-PID layer-0 WindowServer window known to be off-Space, or known to be on
the current Space but off-screen. Unknown membership does not qualify. Each
candidate must have the AXWindow role, exact PID and exact direct SPI window
ID; frame/title approximation cannot establish this identity. The optional
private symbol is resolved dynamically. The 300 ms probe budget is clipped
to any earlier recording deadline, with at most 50 ms per native message and
2,000 candidate tokens. Native calls remain cooperatively bounded.

The tree and fresh action facts retain their existing completeness, ownership,
minimized/hidden and keyboard-ambiguity gates. Default App selection tries the
probe only once after public selection/reopen has finished, and only with one
candidate among all same-PID layer-0 windows. A recovered root still resolves
its attached sheet; an incomplete, ambiguous or foreign sheet refuses selection.
An exactly proven App surface can be selected despite an incomplete global AX
array, as with the existing focused-window path; its subsequent tree/facts must
still pass their stronger completeness gates. No input is sent, window activated,
Space switched, or AX object cached across requests by this recovery.

### Chromium observation readiness (G24 / upstream #3783)

An accepted modern accessibility opt-in remains pending until AXWebArea is
observed. Default App AX observations share one 500 ms readiness deadline
across window selection and tree walking. Recording, input facts and pure
screenshots request opt-in without polling or consuming a wait attempt.
Positive evidence returns immediately; pending results have a 30-second
cooldown and at most three wait attempts per process lifetime. The cache is
keyed by PID and kernel start stamp, with lifetime validation serialized with
publication so a stale completion cannot overwrite a newer process's readiness.

Independent controlled verification covers 16 readiness cases, the old/new
publication race, and two actual core propagation tests. Real Chrome rejected
the opt-in in the available fixture, so accepted-path native readiness remains
unverified. The 500 ms budget is not a whole-observation latency bound. The
separate AppKit still-launching recovery is described below.

### Native named-key flags found during G17 acceptance

The global chord, desktop held-key transition and both PID named-key builders
overwrite CoreGraphics flags to isolate explicitly requested modifiers. This
also strips the intrinsic Function/NumericPad bits of special keys. Independent
native event construction reproduced the loss without posting any input; the
upstream global helper shares it. Preserve the keycode-specific structural bits
and add only explicit or session-owned modifiers. Do not copy factory flags,
which may contain unrelated physical modifiers. Fn itself remains a held
modifier, so its release has no intrinsic Fn bit. Unicode and bare forwarding
keep their existing event semantics. Routing, timing and single-dispatch
behavior are unchanged. Real Space navigation needs a separate effect oracle.

### AppKit launching-window lookup (G24 / upstream #4309)

The separate AppKit recovery uses a one-second native lookup allowance, the
exact upstream default. Its absolute deadline shares the existing observation
start: subtract the named Chromium readiness budget from that deadline, then
add the launch allowance. Chromium still receives only 500 ms. No readiness
deadline means no launch wait, including recording and action facts. This
internal coupling is covered by a shared-anchor regression test.

Only unresolved windows in a process known to be still launching receive a
retry. Default App selection waits for natural resolution instead of issuing
another reopen request; exact tree discovery retains its full scope/ownership
checks. Retry pauses are at most 50 ms and leave room for the previous attempt's
duration. Each discarded attempt releases its AX objects and incomplete state;
the final attempt determines the result. A tree walk tries the G17 remote-token
fallback at most once across retries. This is a cooperative retry allowance,
not a hard bound on native calls or the complete observation. Existing finished
application reopening, node-walk budgets and outer timeouts remain separate.

Independent verification passed 27 controlled actual-function cases and 49
G17 consumer regressions. It caught a sleep-overrun defect; the repaired loop
checks its deadline again before another active AX retry. The default App
wrapper still calls its ordinary final body, which may itself resolve AX.
A later native G24 fixture establishes still-launching state at the single public request, followed by the correct AX marker in 1.056 seconds and independent finished-launching readback. This validates that cold public chain, but does not identify the retry responsible, prove the old 400 ms path fails, or impose a hard one-second bound: the first AX IPC may itself wait for readiness.

### Recording AX capture budget (G30 / upstream #4215)

Recording AX callbacks run outside the recording-session lock with a fixed
two-second caller backstop. macOS also gives the recording tree walker a
one-second cooperative node deadline, retaining a completed prefix. Ordinary
observations keep their existing budgets. At most four native capture workers
may run, with one per PID; a timeout holds its slot until the provider actually
returns. Late results are discarded. The worker inherits the requesting
runtime, authorization and trusted session evidence, with no primary-runtime
fallback. The callback registration signature remains unchanged.

Before and after capture, the recording verifies that the generation and owner
still match. Only the second check and artifact commit hold the session lock,
so stopping or replacing a recording cannot admit a late capture into either
session. Screenshot privacy rules and video-stop behavior retain their existing
boundaries. This adds native threads, not a process or public budget option.

The new Windows recording thread owns its COM apartment: successful COM
initialization must be paired with uninitialization after all recording-only
node bindings are released. It must not release an apartment when initialization
fails, including a conflicting apartment mode, or publish recording nodes into
the action cache. Other UIA callers retain their existing lifecycle.

The macOS recording hook also owns the walk's extra actionable-element retains.
It uses the existing unpublished snapshot owner to release them after JSON
serialization, without replacing action tokens. Independent actual-walker/hook
tests with controlled AX data and real CoreFoundation reference counts reproduce
one leaked retain per call before the fix and zero after repeated complete and
incomplete captures. Existing tokens remain valid and seven payloads match
apart from elapsed time. Three native regression tests and macOS/SDK all-target
checks pass. These are ownership tests; native GUI capture, serialization failure
and an actual elapsed-budget truncation are not established by this fixture.

### Snapshot identity (G18 / upstream #3616 and #3873)

Upstream #3616 / #3873 require the snapshot identity and its native element
bindings to agree. A controlled concurrent observation reproduced an old App
short ID resolving to a replacement native object: token resolution and the
per-window cache lookup were separate operations.

The existing token registry will publish the window, index membership, token
generation and an immutable owned native payload in one entry. Resolution keeps
an `Arc` to that payload. Platform actions read a bound cache view, including
Windows kind/role/geometry and Linux identity/actions, instead of the latest
mutable window cache. This covers default App calls, raw native calls and their
interleaving without holding a GUI lock across an observation or action. Token
format, runtime isolation, same-window invalidation and the existing LRU stay
unchanged; no upstream SnapshotStore or new public API is introduced.

Publication changes affect the three `get_window_state` implementations and
native element caches. Consumers include click/double/right click, keyboard
input, setValue, scrolling, secondary actions and Mac selectText. Both Mac
`ClickTool` and the separate `invoke_app_click` path use the bound view. Recording
markers also retain the exact binding rather than resolving a bare index again.
Pending captures own their native references and release them on failure or
cancellation. Runtime/target cleanup releases registry ownership; a previously
resolved action keeps its own payload alive until it finishes.

A degraded Mac AX-window observation revokes the previous target snapshot in
the calling runtime; it does not publish an unresolved tree or revoke another
runtime's observation. Each platform cache's `clear_target` also revokes this
runtime's tokens. Existing watchers separately clear all runtime lanes only
after proving that the native window or process has closed. Session dispatch
guards defer end cleanup until the observation finishes; cancellation releases
unpublished pending payloads rather than publishing after cleanup.

Verification pauses publication and lookup around a competing snapshot, checks
old-object identity or a stale refusal, and covers cross-session/raw/App calls,
sparse Linux indices, Windows UIA/MSAA metadata, retain/release accounting and
screenshot-only observations. Native desktop acceptance remains separate.

### Implicit session recovery after idle cleanup (G08 / upstream #4283)

An idle sweep currently leaves the still-connected unnamed MCP/SDK lifecycle
permanently ended. Record whether a tombstone came from idle reclamation of its
owner's implicit lifecycle. Only that same owner may recreate it, at the existing
session admission boundary, after all cleanup hooks complete. Recheck under the
tombstone lock before removing it and inserting the next lifecycle record.
Named sessions, explicit end, transport exit and revocation remain terminal.
The daemon adapter's early mirror must admit this one recoverable state and
follow core revival notifications. Direct SDK and MCP share core admission.

Recreation must not restore prior resources. Snapshot entries retain the private
publishing session identity so end cleanup can retire only its native bindings;
App short IDs, capture scope, grants and recording already have owner cleanup.
Test unfinished cleanup, wrong owner, named/explicit/transport termination,
concurrent admission and an old raw snapshot token after recreation, then repeat
the actual direct MCP idle-TTL reproduction.

### Native Electron background scrolling (G05)

Upstream #4861/#5079 reveal content through native accessibility when Electron
ignores background wheel input. This is a native application operation; it does
not use the upstream browser API. Reproduce the candidate's current refusal and
compare the same owned scroll fixture with upstream before implementation.
The native before now confirms five candidate refusals with unchanged offsets;
stock 0.35.4 moves the inner pane by 114 pixels and the page by 404 pixels in
four corresponding single-request cases.

Adapt the geometry and clamped-row selection while preserving the
approved dispatch contract: prove the exact window and native element ancestry,
choose the innermost relevant scroll container, and send at most one
`AXScrollToVisible` action. Do not copy the upstream fixed 150 ms effect wait or
its retry on another container after an unconfirmed dispatch. Return dispatch
acknowledgement and use the next observation for effect evidence. A preflight
absence may refuse; an uncertain action must not be replayed. Existing Browser
SDK behavior remains outside this change.

Selection is read-only and bounded by 4,000 descendants, depth 80 and a private
one-second cooperative search budget. Failure to select safely refuses before
dispatch. The selected native proxy and process mutation lease live in the
blocking worker through the final exact-target check and one AX action, including
when its async caller is cancelled. A native AX error after dispatch is an
uncertain acknowledgement with a warning; it never starts another route. These
bounds do not impose a hard deadline on an in-flight native read.

The normal v3 SDK passes five native Electron fixture cases: raw inner/page
scrolling through AX and pixel targets, plus default App inner scrolling. Each
case uses one request; independent fixture IPC observes inner +114 pixels or
page +404 pixels while the other region remains unchanged. The original
unconfirmed acknowledgement is preserved. A separate exhausted-inner fixture
reveals the before defect: both v2 and v3 move the inner pane up 96 pixels
after a single down request. Normal v4 repeats the five main cases and passes
raw/App exhausted-inner refusals with actual sent:false and unchanged offsets.
These seven cases do not establish all-direction behavior,
human concurrency or absence of shorter unsampled interference. The v2
controlled 43-case result and v3 four geometry unit tests remain distinct from
the v3 controlled executable's startup timeout.

The exhausted-inner diagnostic identifies an earlier row reported at the
bottom edge as a one-pixel sliver. The native container is correct; revealing
that row reverses the intended movement. The v4 selector uses its existing
visible-leaf set to reject clamped targets on the wrong side in document
order: down/right after the last visible leaf, up/left before the first.
It adds no native reads or actions and leaves real-frame selection unchanged.
When no visible anchor exists, the previous heuristic remains; reordered or
multicolumn AX graphs still need separate evidence. This is a scoped repair
for the reproduced case, not a universal direction guarantee.

Normal v7 independently repeats all seven native GUI cases with source tree `70001802535ebff45ed2f9bc8a0a55b0ba7edfb6f07d1c76aae1b5eb6a002693` and SDK SHA-256 `4d2b048131c42055991f1716b41691715da9abf3b7b176fc125548a12dff60fe`: seven pass, without replay or foreground fallback. Independent fixture IPC confirms the same +114px/+404px offsets and unchanged exhausted boundaries. The 143 samples retain foreground/topmost A, pointer position and clipboard count. All 634 referenced entries are verified. Sampling at 8.444–12.213Hz does not establish absence of shorter interference or human concurrency.

### macOS release replacement recovery (G36)

The actual release-install branch loses the previous bundle if copying fails:
two isolated before cases confirm that failure before copying or after a partial
copy leaves a broken executable symlink. Adapt #3297's staged validation and
backup/rollback, using the existing bundle path and signing identity. Verify the
downloaded bundle before touching the installed application, keep its previous
bytes in a sibling backup until the copied bundle and executable are validated,
and restore them on copy/verification failure or a handled interruption. Preserve
the backup and report its path if restoration fails. A process kill or power loss
cannot execute the shell trap and is not claimed to recover automatically.

Compare the replacement against the previous designated signing requirement to
report permission continuity accurately. Do not import upstream automatic TCC
resets: installation never changes authorization records. Defer old local-build
cleanup on macOS until replacement succeeds. This keeps the existing installer,
daemon, bundle location and permission owner; no new service or helper process
architecture is introduced. Validation uses isolated directories and controlled
system-command boundaries, not a real application or permission installation.

### Additional verified upstream ports

| Reference             | Adaptation and evidence                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4967 / #4214         | Linux top-level frame rebasing and local XRes PID fallback. Real GTK before/after fixes wrong-row input and missing windows without `_NET_WM_PID`; scoped to the tested Xorg environment.                                                                                                                       |
| #2907 / #4690 / #5137 | macOS window clicks select one native delivery route; middle clicks retain the exact window. Two fresh mini parent/sheet rounds remove duplicate target events.                                                                                                                                                 |
| #3755 / #5125         | macOS screenshot uses the absolute system executable; window bounds reject non-finite native numbers. Restricted-PATH real capture and native CFNumber regression pass.                                                                                                                                         |
| #5136 / #4333 / #3975 | Windows console inheritance, GDI failure cleanup and resolved shortcut environment paths. Actual MSVC tests pass; interactive desktop behavior is a separate pending gate.                                                                                                                                      |
| #3277 / #4985         | Embedded driver preserves explicit telemetry and update-check preferences through its environment filter.                                                                                                                                                                                                       |
| #3462 / #4888         | Shared typed schema generation removes Schemars-only numeric formats; input declarations use the supported dialect while runtime validation remains authoritative. Declaration tests and offline MCP wire checks are distinct from provider acceptance.                                                         |
| #3632                 | Recording reserves turns only for its owner session or implicit trusted connection; lifecycle calls are omitted. Independent testing caught an implicit-owner omission; the second fix passes public registry checks for named owners, implicit connection owners, foreign connections and lifecycle exclusion. |
| #4238                 | ScreenCaptureKit stop waits for the recording-output finish callback. Real mini baseline reproduces false empty-file failures and post-return growth; five new-candidate 120ms recordings decode immediately and retain the same file hash after one second.                                                    |
| #3328                 | Display scaling reads the current mode's backing pixels divided by points. The public tool reports 2 instead of 1 on the same real Retina display; coordinate dispatch is a separate contract.                                                                                                                  |
| #3714 / #5144 / #5145 | Encoder exit/timeout becomes an explicit error, and recording timestamps preserve one start baseline with ISO-8601 action timestamps. Public API probes verify the failure details and output metadata.                                                                                                         |

This table records implemented groups, not a claim that every upstream commit has
been reconciled. The full inventory and remaining native gaps are tracked in the
acceptance evidence ledger. A successful cross-platform build does not replace
real desktop effect and interference checks.

## Validation boundaries

See the ignored `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/` reports for immutable source manifests, build logs, protocol calls and fixture readback. The current [acceptance snapshot](cua-upgrade-acceptance-2026-10.md#acceptance-clarification-2026-10-20) separates earlier controlled/GNU/Xvfb checks from the later actual Windows MSVC and interactive-desktop tests, Linux Xorg/uinput/Mutter tests and macOS native fixtures. None establishes physical-human concurrency. The user clarified that observed transient macOS target/menu cover is acceptable; retain measurements and recovery separately from functional correctness. Model task success, token counts and timing parity require actual second-layer evidence. The user scheduled OSWorld after release on 2026-10-20; it is not a pre-release gate.

Later acceptance repairs supplement the upstream ports. Exact AppKit key-window records fix the reproduced sheet Return failure; they contain internal NaN-location mouse events and do not solve pointer/window coverage. Isolated Windows uninstall ownership now covers every task action and only the selected process/install roots, verified on actual PowerShell. Finite CLI commands skip their observation self-wrapper when effective telemetry consent is false; existing consent precedence and enabled behavior remain. This CLI-only v21 change is verified separately from unchanged SDK backend artifacts. Package/runtime appendices retain local developer signing and installer seam limits; they do not establish official signing/notarization or a production release.

### Acceptance-driven input boundary repairs

Linux v24 distinguishes pre-dispatch refusal from uncertain delivery throughout text prefixes, first/named-key presses, releases and flushes. Event-emission errors carry sent uncertainty even when the first requested press fails; preinput focus checks still refuse before input. MPX pending requested input is retained only after target-focus admission. A failed press and the focus-probe key each get bounded best-effort release cleanup, retaining uncertainty instead of claiming completed text. Real focused tests and fresh Xorg/Mutter cases separately verify this behavior; an uncertain paused-target result is never automatically replayed or scored as complete text.

Mac v25 handles an app-focused same-window AXGroup that explicitly reports AXFocused=false while a genuine text descendant holds focus. It delegates only this shape to the existing complete, unique, bounded actual-focus search. Unknown focus, cross-window focus and other roles keep their existing behavior; PID/window checks and final focus/window revalidation remain. Actual LibreOffice ASCII insertion passes. The original Cmd-S/AppleEvents Save remains UNKNOWN; an independent v25 toolbar Save has actual FODT evidence. Accepted transient target/menu cover remains measured in the acceptance record. AX settable/edited flags alone do not establish an applied edit or saved file.

### v26 pointer-reading target refusal

A real Calc request selected B28 instead of requested C5. Exact LibreOffice VCL source computes mouse callback coordinates from the global hardware pointer, which PID-routed clicks do not move. Following upstream #4864's safety principle, the fork now identifies the official `org.libreoffice.script` app through its existing NSRunningApplication boundary and refuses routed pixel click/right-click/double-click alternatives before input. Raw foreground PID routes also refuse; merely activating a window does not fix this mismatch. Advertised AX actions and safe AX editable-focus/selection remain available. This scoped identity rule is not upstream's general mapped-library detector, so it makes no claim for rebranded/unbundled VCL targets. Canonical public Mac delivery stays background-only.

The v26 tree `9bb4ffe40e1801d750f5a71ae20ea354293fe8bff01f0191554a7ca1facaabe3` changes only these three Mac tools from v25. A fresh public-contract refusal returns background_unavailable/sent:false and leaves the same exact-window Name Box at A1 in three bounded reads. This is a safety refusal, not successful C5 background selection; raw AXPress runtime equivalence remains separate. The historical strict zero-cover predicate was not met, but the user subsequently clarified that observed transient target/menu cover is acceptable. See the v26 acceptance checkpoint for native/source/build evidence and the retained original harness-assertion failure.

### v27 scoped Writer editable focus

The official LibreOffice Writer body exposes AXTextArea with no advertised action and writable AXValue/AXFocused. The intermediate v27 candidate admits only this bundle's text area into the default App branch's editable-focus path, retaining both attribute gates, exact ownership, single unmodified left-click conditions and value-preserving focus readback. Generic text areas do not gain this shortcut; the raw path is unchanged from v26. Fresh mini native reads show that this admission alone does not establish focus, despite a successful AX setter status.

F31 adds existing exact-window background keyboard preparation and an existing read-only selection-range query before the single AXFocused setter. The same-version LibreOffice caret getter initializes its cursor cache/context, which explains the purpose of the otherwise non-obvious read. There is no range write, caret relocation, text replacement or pixel fallback. The original observer, which makes no caret query, reads the same seed body false before and true after one fresh mini App click. One input and one toolbar Save then produce exact live and saved XML text. Conservative confirmation and sent/unconfirmed results remain: observe before the next action, never replay. A preparation failure can follow native focus records and must not be treated as proof that nothing was sent. Rejected prep-only and range-write experiments retain their own source and native evidence.

Preparation retains the existing keyboard-target ambiguity gate because it can send a PID-scoped ReturnKeyFocus notification before the exact-window records. An AX element binding alone does not prove that notification safe with competing keyboard destinations. The two fresh Writer positives each have one document window; arbitrary multi-window focus switching is not established or enabled by deleting the safety gate.
