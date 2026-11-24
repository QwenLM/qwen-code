# Web Shell session-list density

[English](web-shell-session-list-density.md) | [简体中文](web-shell-session-list-density.zh-CN.md)

## Problem and current state

Long session titles compete with inline Pin, row accessories, and the PR badge. This is most restrictive in the mobile drawer, but desktop narrow-embed layouts have the same constraint. PR number and state are useful metadata; removing their visible status is not an acceptable density improvement.

The implementation in this PR keeps the existing session-list, PR, organization, archive, and rename models. It changes presentation and action routing rather than introducing a second list or persistence layer.

## Goals and scope

- Give session titles more space on touchscreens and desktop.
- Keep PR number/state icons, links, and accessible descriptions visible.
- Keep caption/status markers and workflow actions available without adding lines to each row.
- Preserve capability, disabled, and standalone behavior for Session and Recent rows.
- Keep the originally supported desktop plain-title double-click Rename gesture.

Row-layout or title-editor redesigns, sorting changes, archive semantics, and unrelated iframe/generated-UI behavior are out of scope.

## Layout and action routing

A coarse pointer receives an 85% drawer through `(hover: none) and (pointer: coarse)`. A narrow, fine-pointer desktop viewport retains the original clamped 70% rule; it must not be treated as a touchscreen merely because it is narrow. Explicit host min/max width variables remain in both calculations.

The default desktop More menu owns optional Pin, along with the existing Rename, archive, group, split, and delete choices. On a fine pointer, an explicit host `inlineItems` override still renders the requested inline actions. Coarse pointers route those actions through More instead of reserving multiple persistent icon slots.

Recent rows keep their desktop Pin/Archive buttons. Their coarse-pointer representation uses the same `SessionMenu` and Pin/Archive handlers, including the existing capability, busy, running/current, and standalone restrictions. A coarse touch viewport at most 280px wide, or a measured host of that width, omits the decorative Git/source icon; it does not remove PR or goal information, nor change hover-details data. The meta slot keeps status markers in the flex layout and anchors only More at the row's right edge, so these markers neither widen the More slot nor cover the goal marker. For a row whose PR badge or goal marker reserves the action width, the presence of attention, continuation or running metadata in that reserved slot enables wrapping; it does not trigger a fit calculation. Status-only rows without a PR badge or goal marker are outside this wrapping rule. A long title can occupy the first line while the PR badge, goal marker and status markers flow into one or more later lines, depending on their content. The markers are not required to occupy a fixed vertical order. On those wrapping rows, More and its action container remain in the top-right with a 26px button, while the left status slot and tree toggle stay aligned with the title. The wrapped-line gap keeps More from reaching the next metadata line. Rows without those markers retain the original vertically centred action layer. This preserves the 26px hit area without covering statuses or swallowing row clicks outside the action area.

The PR badge uses compact spacing without dropping its number, visible state icon, link, count, or ARIA description. Other badge consumers retain their non-compact presentation.

## Interaction boundaries

Independent pointer and viewport match-media listeners update the coarse/fine action model and narrow-row layout without overwriting one another's state; both listeners are removed on unmount. The subscription covers attachable keyboards, trackpads, and resized/narrow desktop hosts without turning the check into a render-only snapshot.

Radix session menus portal outside the physical drawer. The App drawer therefore treats `[data-slot="dropdown-menu-content"]` as owned by its logical surface for both Escape and `touchmove`: Escape closes an open menu, native touch scrolling stays inside a short menu, and a subsequent Escape closes the drawer. The self-built Group menu is marked as part of the same logical keyboard/touch surface.

While a session or group menu is open in the sidebar, hover-only details are closed and queued hover opens are cancelled, so they do not create another dismissal layer over the menu. Ordinary hover resumes when the menu closes; click-pinned details are unchanged. On narrow touch layouts, the scheduled-task marker retains its 14px glyph and accessible label, but its non-interactive container is 20px high so it does not raise the title-row flex line.

A Group menu can mount before Radix finishes dismissing More. More's close-auto-focus then focuses the Group selection while that menu owns interaction, rather than restoring the old trigger. Once Group closes through Escape, it restores the More trigger. This prevents an asynchronous More teardown from stealing or losing Group keyboard focus.

Row controls already intercept clicks and keyboard events. They also intercept double-clicks so an interaction with a menu item or blank menu padding cannot bubble through the React portal and start Rename. Plain-title double-click Rename remains on desktop; it is not asserted as a new mobile gesture, because clicking a mobile session row selects it and closes the drawer.

## Constraints and risks

A narrower or variable title space depends on host width, fonts, and localization. Tests consequently assert meaningful geometric budgets, preserved controls, and real event outcomes rather than a device-specific pixel or font rendering.

Base visual captures inject only the missing scenario and fixture. Their expectations follow the actual base implementation; an injected test is not treated as evidence that the base already includes the PR's new behavior. Functional mobile and desktop checks use the blocking `@smoke` lane, not only visual captures whose workflow may retain partial evidence.

## Validation plan

- Run the sidebar, badge, customization, and menu-lifecycle unit tests, Web Shell typecheck, build, lint, and formatting checks.
- Capture base/head iPhone and desktop light/dark images; verify the expected images exist and differ.
- Exercise coarse/fine/coarse changes, explicit desktop overrides, More Pin/unpin, capability-restricted Recent actions, and folded surfaces.
- In Chromium touch emulation, use real Escape presses, menu double-clicks, and CDP touch moves. Verify menus scroll, the drawer remains open after the first Escape, and no portal double-click starts Rename. Separately verify plain-title double-click Rename on desktop.
- Start an isolated daemon with its own HOME/workspace, create a real session through HTTP, drive Pin/unpin through the UI, and verify the returned session state and persistent on-disk changes. Do not read or mutate the user's shared daemon or session state.
- A Chromium emulated viewport is not Safari or physical-iOS certification. Run supported WebKit/device coverage where its runtime libraries are available.

## Acceptance criteria

1. Long titles have usable space in touch drawers and desktop layouts, while PR state remains visible and operable.
2. Every existing action remains reachable under its previous capability and disabled rules.
3. Menu keyboard/touch ownership and double-click isolation work through actual browser event paths; normal desktop renaming still works.
4. Visual evidence has a genuine base counterpart and behavioral checks are not hidden behind best-effort capture steps.
5. The final report names the executed checks, real-daemon persistence results, and unsupported native-device boundaries.
