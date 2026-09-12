# Discover visible application dialogs on nonzero layers

[English](osworld-dialog-discovery.md) | [简体中文](osworld-dialog-discovery.zh-CN.md)

## Problem and scope

Verified native47e omits Excel Format Cells while its live CGWindow is at layer8. The same window moves to layer0 when Excel becomes inactive. Independent AXWindows identifies it as AXWindow/AXDialog, AXModal=true, directly owned by the application. An exact-ID observation works, but normal SDK callers cannot discover that ID. The separate lifetime patch keeps an observed nonzero-layer target alive across the 500ms sweeper.

## Proposed behavior

For list_windows with an explicit pid, retain existing layer0 records and supplement visible nonzero-layer windows independently identified as dialogs by that process's AXWindows. Admit AXSheet or AXWindow with AXDialog/AXSystemDialog subrole or AXModal=true, only after matching the AX window ID to a live same-pid WindowServer record. Do not expose arbitrary menu, tooltip, Dock or overlay windows. Without pid, discovery keeps its existing layer0 behavior.

Read at most64 AX roots, with100ms AX messaging timeouts and a500ms overall deadline, on a blocking worker. A worker failure returns an explicit tool error. Only inspect AX when the requested process has an on-screen nonzero-layer CG candidate. AX failure adds nothing; it does not erase ordinary windows or authorize input. Rebuild the PID list from one final CG snapshot so all z_index values share the same scale, retaining the original visibility and Space metadata rules. Background delivery guards, exact-window observation, screenshot selection, main-window selection and the one-second action observer remain unchanged.

## Validation and limitations

Verify through real MCP: cmd+1, pid-filtered discovery finds Format Cells at layer8, exact-ID observe returns the correct dialog, delayed token click actually cancels it, and closed-token rejection remains. Check dialog identity across activation/layer changes, no duplicate records, ordinary NameBox selection, no unrelated overlays, and the no-pid listing remains filtered. Record discovery latency with and without a dialog. Unit coverage checks admission for sheets/dialogs versus ordinary windows and failed/absent metadata. Native tests, release build, two self-audits and independent review precede verified staging.

This is a mechanism fix, not a complete OSWorld task speedup claim. Dialogs unavailable in AXWindows or without recognized dialog evidence remain undiscoverable through this supplement. A one-second action result can still omit a late/nonzero-layer window hint; callers use the existing listWindows(pid) discovery path.
