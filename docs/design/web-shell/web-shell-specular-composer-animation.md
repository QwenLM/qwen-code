# Web Shell Specular Composer Animation

## Goal

Replace the current composer-only DAC glow with the supplied specular edge
animation, and add the supplied DotField animation behind the empty new-session
view. Existing composer behavior, layout, controls, and keyboard handling remain
unchanged.

## Scope

- Render a WebGL edge highlight around the complete composer surface.
- Follow pointer direction while the composer is unfocused and within 250 CSS
  pixels of the pointer.
- Continue from the current highlight angle and rotate at 0.85 radians per
  second while the editor is focused.
- Keep the supplied light and dark animation colors and support live theme
  changes.
- Render the DotField only while `isChatEmptyState` is true.
- Play the empty composer placeholder twice with a three-second pause, then
  leave the complete placeholder visible.
- Preserve the current 12 pixel composer radius and use that radius for the
  shader geometry.
- Preserve all existing CodeMirror, mobile textarea, toolbar, attachment,
  submission, and disabled/running behavior.

The demo's page layout, toolbar styling, send button styling, and fixed
20-pixel composer radius are not part of this change.

## Structure

`SpecularComposerEffect` owns the composer canvas and all pointer, focus,
resize, animation-frame, and WebGL resources. It is an inert sibling of the
composer content and never receives pointer events.

`NewSessionDotField` owns the empty-state background canvas. `App` mounts it
only for the empty new-session state, so starting or loading a session removes
the canvas and releases its resources.

The composer effect uses WebGL2 directly, while the DotField uses the browser's
2D canvas API, matching the handoff without adding a runtime dependency. If
WebGL2 is unavailable, the specular canvas remains absent and the existing CSS
surface continues to work.

## Motion and accessibility

The composer highlight uses the supplied 32 degree highlight and 68 degree
fade, a one-CSS-pixel edge, 1.0 proximity intensity, and 1.4 focused intensity.
Focus and blur both lock the current angle before changing modes, so the
focused rotation stays clockwise and never jumps or reverses during
hover/focus transitions. The hover/focus underlay expands four pixels around
the existing radius.

The DotField uses 1-pixel dots on a 15-pixel grid, a 500-pixel pointer radius,
0.1 pointer force, a 67-pixel bulge, and a 160-pixel glow. The glow erases the
canvas dots so the actual host background shows through without color
interpolation.

The typewriter stops as soon as the user interacts with the editor. If the
empty editor loses focus, it gets another two-run sequence. Empty placeholder
strings do not mount the effect.

When `prefers-reduced-motion: reduce` is active, both animation loops remain
disabled. Changes to the system preference apply without reloading the page.
The composer retains its ordinary CSS border and focus affordance.

## Lifecycle and verification

Each effect cancels animation frames, disconnects its `ResizeObserver`, and
removes event listeners. The composer effect also deletes its WebGL resources
and loses its context. Tests cover empty-state mounting, non-empty removal,
composer effect presence, and WebGL-unavailable fallback. Existing composer
interaction tests guard against functional regressions.
