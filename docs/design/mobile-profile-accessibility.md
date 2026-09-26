# Android connection profile accessibility

[English](mobile-profile-accessibility.md) | [简体中文](mobile-profile-accessibility.zh-CN.md)

## Problem and scope

The native connection list repeats Connect, Edit and Delete without identifying
the profile in each action's accessibility label. The editor's visible labels
are not associated with their inputs. Validation messages have no live-region
semantics, and the storage recovery page cannot scroll when large text or a
short landscape window pushes its controls below the viewport.
Editor validation can also appear outside that viewport while the input retains focus.

This follow-up changes only native profile management. It does not change
WebView settings, font scaling, credentials, daemon APIs or connection recovery.
Activity/process restoration and full Web Shell accessibility remain separate
work. Chromium already derives its initial text zoom from the system font
scale; this change does not override it.

## Design

Keep the existing visible button text and give each profile action a localized
accessibility description containing the action and profile name. This provides
context when users navigate directly between buttons. Profile names are already
visible; credential values must never enter these descriptions.

Give each editor input a generated view ID and associate its existing visible
label using `labelFor`. Keep the input hints, password transformation, disabled
state saving and disabled autofill unchanged. No token is copied into a label.

Mark the editor's validation message and the storage failure description as
polite accessibility live regions. This exposes semantic information for
accessibility services without interrupting their current speech. Rendering
these properties does not itself establish that a particular service speaks
every update; actual TalkBack behavior requires separate manual acceptance.
After updating validation text, `showError()` posts a `requestRectangleOnScreen`
request so the enclosing scroll view reveals the message after layout without
moving input focus or forcing an accessibility announcement.

Wrap the storage recovery page in a `ScrollView`, matching the other native
pages. Retry and Reset keep their existing behavior and confirmation. The page
must remain operable with enlarged system text and in landscape orientation.

## Files and validation

Production changes are limited to `MainActivity.kt` and `strings.xml` under
`packages/mobile-shell/app/src/main`. Instrumentation tests assert distinct
profile action labels, field-label relationships, password semantics,
live-region metadata and a scrollable recovery page with reachable
controls. Existing JVM tests, debug/release compilation and Android lint remain
required.
The validation test corrects an invalid address and changes the profile name,
then checks the non-editable list and persisted profile to prove Save completed.
Device fixtures refuse to overwrite existing profiles, unreadable vaults or
legacy credentials; only an empty test installation may be seeded or corrupted.
Setup/teardown preserve the original empty vault bytes without replacing keys.

Run baseline and changed APKs on an emulator with synthetic profiles. Capture
native accessibility nodes and screenshots of the list, editor errors and
storage recovery with large text/landscape. Verify the editor error becomes
visible after layout while the input remains focused. Check saving, editing, deletion
cancellation and recovery actions for regressions. Record the API/provider and
which tests ran. Do not describe node inspection as an actual TalkBack test or
infer physical-device acceptance from emulator results.
