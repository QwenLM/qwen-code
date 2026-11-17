# Linux observation memory and compaction

[简体中文](linux-observation-memory-and-compaction.zh-CN.md)

## Scope

Extend the existing Linux recovery candidate in exactly two areas: compact
accessibility presentation and bounded LibreOffice observation resource use.
App APIs, clipboard and OSWorld code are outside this change. Prepare SDK/driver
0.20.9 with synchronized version pins; publishing remains a separate action.
The SDK-to-native AT-SPI topology, permissions and installation remain unchanged.

## Compact presentation

The previous candidate shortened individual rows, but did not migrate the
structural projection present in macOS 0.20.6. Linux also built revision text
from actionable nodes alone, losing passive status and instruction text.

Retain observed passive context, then flatten empty layout containers, remove
duplicate parent/child labels, and merge adjacent passive text under the same
parent. Preserve window, dialog, menu, list, table and document boundaries,
web-content boundaries, focus, selection, disabled state and all actionable
nodes. Use iterative projection so deep trees do not consume the call stack.
Native indices, identities and the structured action list remain intact.
Revision comparison includes the retained static text and editable empty values.
Apply projection at the model observation boundary; internal browser setup and
consent matching retain original static-label boundaries.

## Memory investigation

The original Task035 workbook exposes 1,073,741,824 table children and the
`manages-descendants` state. A controlled single `GetChildren` request increased
LibreOffice RSS by 107.75 MiB in 24.14 seconds (4.45 MiB/s), while the requesting
process stayed flat. The supervisor stopped the owned process at its soft limit;
no OOM was needed to reproduce the growth. This is a direct AT-SPI reproduction,
not proof of the historical sandbox reboot cause.

The instrumented b30 candidate also reproduced growth through real SDK calls:
all three observations returned X11 fallback, while the trace stopped at the
table GetChildren with no reply. During the third call LibreOffice grew at
4.52 MiB/s and Node RSS stayed flat. Returning from the caller does not cancel
provider-side enumeration.

For ordinary nodes, replace whole-child arrays with `ChildCount` and lazy
`GetChildAtIndex`. Keep one next-sibling cursor per ancestor; check node, depth
and time limits before requesting a child. Preserve the existing preorder and
shared actionable-index calculation in snapshots and actuators. A depth limit
reads metadata without expanding children; a failed child request marks the capture incomplete. The fix does not
disable Calc accessibility or allocate a complete array and truncate afterward.

Indexed access alone proved insufficient: three passes over the same 512 real
cells each completed in about 2.8 seconds, but each retained another 3.3–3.4 MiB
in LibreOffice and some cells received new AT-SPI object paths on every pass.
AT-SPI explicitly says clients should not enumerate `ManagesDescendants` nodes.
Do not expand these virtual children; retain the table and the rest of the UI,
and report `managed_descendants_omitted` as a bounded capture. This limitation
preserves identities for captured controls without claiming complete sheet
content. Use screenshots for omitted content. No application-specific process
restart or event-driven accessibility subsystem is introduced.

## Ordinary-layout collection

The ordinary Calc window also exposed a large hidden menu tree. An independent
bounded census found 1,861 nodes, of which 1,638 were not showing, and 11,188
explicit D-Bus calls without errors. The diagnostic final3 SDK completed 770
nodes before its 25-second deadline; 752 were not showing. No individual call
timed out. This was cumulative traversal work, not a stuck LibreOffice method.
Native timed wrappers include peer-to-peer traffic and are not a count of bus
messages; the independent census has a separate sequential-call timing scope.

Read role, state and supported interfaces together, then omit hidden native
menu nodes and their subtrees before reading names, details or children. Keep
showing, focused, selected or expanded menus, and do not apply the rule within
web content or when visibility is unknown. A menu opened by the user is read
on the next observation. Report `hidden_menu_subtrees_omitted` as an explicit
bounded capture, preserving identities only for controls actually captured.
Omitted commands consume no actionable index; tokens resolve by captured AT-SPI
identity so opening a menu does not retarget an existing token by row number.

Collection now receives the snapshot's absolute deadline, including setup and
the subsequent bounds phase. Keep accumulated nodes and bounds outside the
cancelled futures so a slow later request cannot discard all prior work.
Deadline exhaustion remains an incomplete read and cannot retain stable
revision tokens. The native 25-second maximum is unchanged. The facade returns
`walk_deadline_reached` and `element_bounds_timeout` captures without its usual
automatic read retry; short read failures retain one retry. Real fault injection
showed that retrying an exhausted capture otherwise takes about 51 seconds for
two native reads. A later explicit observation can recover normally.

## Validation

Compare compact output against the same complete captured tree, checking
retained content and actionable identities as well as row/character reduction.
Exercise static-text changes, no-change revisions, field clearing, table rows,
web boundaries, current tokens and deep layouts. Run real SDK observations and
independent application readback on the owned Linux desktop.

Measure LibreOffice and the SDK process before, during and after single and
repeated observations; retain raw samples and operation status. Compare the
unchanged baseline and candidate against the same document. Do not infer
provider token costs or historical OOM causality from shorter text or a timeout.

The memory-only candidate (`6babbd96`) passed four full-screen observations,
but three ordinary-layout observations timed out at 25.762, 25.042 and 25.048
seconds. This exact-binary comparison, followed by the instrumentation above,
established the separate hidden-menu traversal problem.

The ordinary-layout repair (`d4ba57b6`) returned useful Task035 trees in 11.570,
10.989, 13.454 and 10.815 seconds, with 157/157/190/157 actionable elements.
All four reached the real table and retained its token; the unchanged second
read returned `no_change`. File activation exposed 33 additional menu labels,
and Escape restored the initial menu-label set. Both intentional omission
reasons were reported, with `captureReadComplete=true` and `captureComplete=false`.
Continuous samples over 68.986 seconds showed LibreOffice RSS between 340644
and 340652 KiB, with a maximum sampling interval of 0.163 seconds. This is
bounded real-application acceptance, not a long-duration leak or benchmark test.

The same native passed a real GTK comparison: legacy tree text stayed
byte-identical, control depth fell from 10 to 2, static instructions survived,
and token click, field replacement/readback and no-change/token stability all
passed. Revision text grew from 352 to 554 characters because the baseline
omitted passive information; this is not a measured token-cost reduction.

Controlled AT-SPI providers verified completed node and bounds preservation,
continued traversal after a failed child, and no descendant enumeration after
a failed state read. The old facade made two reads in 50.785 seconds for the
metadata deadline and 50.965 seconds for the bounds deadline; these are
before-fix retry measurements, not the intended latency of 0.20.9.

The final 0.20.9 package (`3554fe81` native, `f0ba1e38` facade) repeated the
metadata deadline in 25.833 seconds with exactly one native snapshot, retaining
26 controls and issuing no bounds requests after collection expired. A fresh
ordinary maximized Calc run returned 157 controls in 11.084 seconds, then
`no_change` in 10.492 seconds, with the same table token and both bounded-capture
reasons. LibreOffice RSS stayed at 340228 KiB over 23.471 seconds of samples,
with a maximum interval of 0.153 seconds. This final smoke used the packed
0.20.9 SDK and verified native, JavaScript, package and canonical skill hashes.

Final version checks: Linux unit tests 294 passed/4 ignored; SDK tests 164
passed/6 environment-dependent cases skipped; canonical skill 7 passed;
release workflow tests 68 passed/1 skipped. The release build and package
verifier passed pack, publish dry-run, checksum-based clean installation,
canonical skill byte comparison and native loading (60 tools, revision support).
Node REPL remains 0.1.5. No release was published by these checks.
