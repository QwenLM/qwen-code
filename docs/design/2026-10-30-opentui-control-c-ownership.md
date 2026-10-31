# OpenTUI field clearing and Ctrl+C ownership

[English](2026-10-30-opentui-control-c-ownership.md) | [简体中文](2026-10-30-opentui-control-c-ownership.zh-CN.md)

## Problem and status

Before this change, OpenTUI Auth and Permissions fields omitted Ink TextInput's Ctrl+C clear operation. The process-global exit handler also checked only key name/control, ignoring the original QUIT binding's Shift exclusion. These are separate owners of the same input, not alternative interpretations of one command.

All 12 added unit regressions reached their intended RED failures. The implementation is applied and its scoped validation is recorded below. Initial runs also retained an existing resize fixture's failure when an absolute temporary path exceeded the dialog's 100-column cap. An attempted wide-viewport correction first had a `wideWidth` scope error and then still failed at that cap; both observations remain recorded. The portable fixture now checks the visible parent basename at width 100 before and after its four-column hidden-input phase, while submission still requires the exact full realpath. Hidden-input, completion and trailing-TAINT guards remain.

The first global installed Ink run failed its original row observer before Ctrl+C was sent: Ink draws nested borders and a `> ` prefix. A corrected pair of explicit renderer-specific row patterns keeps `WebFetch` exact. The separately bound second global Ink run passed the whole new public case with zero model requests and a natural exit. The first observer failure is retained; this installed baseline does not establish candidate OpenTUI success.

## Decisions and scope

Add an explicit `clear()` transaction to the existing field hook. A nonempty live field commits the empty value once, preserving text/caret Undo and the existing 100-entry history contract; empty or settled fields do nothing. Keep owner acceptance/checkpoint limitations from the [dialog editing design](2026-10-30-opentui-dialog-editing.md). The real numeric context owner accepts an empty string; test its accepted `auto` display and Undo followed by submission of the original number. Custom-model text is accepted before separate model-ID normalization; model-search text is accepted unchanged.

Route the original CLEAR_INPUT matcher only at the focused Auth URL/API-key/custom-model/search/numeric fields and Permissions rule/directory fields. Retain view, visibility and settled guards. Do not put Ctrl+C in the pure reducer, which also serves password/manual input. Sources, AskUserQuestion and non-sensitive acquisition settings remain explicit follow-ups; Discover's handwritten search and sensitive password Ctrl+U behavior are not automatically replaced. External editing is separate work.

Local clearing must not call `preventDefault` or `stopPropagation` to swallow the process-global event. Ink broadcasts Ctrl+C to field and app owners: the first press may clear while arming exit, and a second press in the existing window can quit. Reuse the original QUIT/EXIT matchers at the global entry without changing release filtering, cancellation, guard windows or the nonempty-composer Ctrl+D gate. Ctrl+D does not edit a dialog field; its global eligibility is not determined by that field's length.

The main composer's separate Ctrl+C branch also uses its own CLEAR_INPUT matcher and owner regression so Shift+Ctrl+C preserves its draft. A global matcher fix cannot prove composer behavior, nor can mocked decoded-key tests qualify the terminal byte parser or full C/D modifier/timing parity. Do not generalize local success to parked-question Cancel ordering or authentication-specific exit windows without their actual lifecycle evidence.

## Public validation

Reuse the existing `tui-editor-parity.test.ts` scenario and public `InteractiveSession`, not a new driver. The new `permissions-clear-undo-replace-without-model` case has the existing 90-second bound and no retries: open `/permissions`, paste `WebFetch`, clear to the placeholder while observing the exit hint, Undo to the exact original field row, observe guard expiry before a separate clear, replace with `Read`, submit the real scope chooser, and require settings to contain only `Read`. Return to the composer, `/quit` with exit 0/signal 0, and require zero model HTTP requests.

After the recorded global installed Ink baseline, run Node+Ink, Bun+Ink and strict Bun+OpenTUI for the separately built candidate. A fixed public `options.command` must carry the original full CLI arguments. The baseline records finite launcher bytes/realpath only unless more identity is independently observed; product commit/version/runtime stay unknown and separate from harness HEAD, diff and Node identity. Do not substitute the harness bundle or a harness version probe for installed-product identity.

Keep the original REDs and any baseline observation failure. Inspect actual frames if the new observer cannot establish the expected UI; do not weaken exact rows, infer a passing baseline, or call a different installed revision defective without qualification. Run affected whole unit files, original exit/cancellation guards, build/typecheck and lint before acceptance. This batch does not complete the migration, change the default renderer or remove Ink.

The initial eight whole unit files passed 612 tests. A subsequent review found a stale directory error after accepting Tab completion; its regression failed before the one-line fix, and both whole Permissions files then passed 28 tests. Build, typecheck, lint and the normal bundle completed after that fix. The final source bundle passed three public cases under each of Node+Ink, Bun+Ink and strict Bun+OpenTUI: Source history/cancel/cold reload, Permissions completion, and Ctrl+C clear/Undo/replacement. These nine executions produced 12 natural exits and no model requests. Exact initial empty-store and persisted-array assertions were strengthened. This is source-bundle evidence from a reviewed working diff, not an installed package or merged-main qualification.
