# Composer Add Menu Presentation

[English](composer-add-menu-icons.md) | [简体中文](composer-add-menu-icons.zh-CN.md)

## Problem and scope

Issue [#16155](https://github.com/QwenLM/qwen-code/issues/16155) identifies
inconsistent presentation in the composer Add menu. The user supplied a visual
reference and requested boxed icons, clearer text hierarchy, and a compact
layout. Preserve the existing menu background and border. Give Plan the same
visual weight as other actions. Keep action order, availability, focus
behavior, and confirmed mode changes unchanged.

## Design

Reuse `lucide-react` and the existing dropdown and button primitives in
`packages/web-shell/client/components/composer/AddMenu.tsx`. Use Paperclip for
Add file, FileText for Reference file, Blocks for Extensions, Plug for MCP, and
Sparkles for Skills. The last three match the workspace menu's existing icons.
Use the same icons for corresponding mobile drawer entries; its separate photo,
camera, and upload actions use Image, Camera, and Upload respectively.

Add short English and Chinese descriptions to the five desktop entries and the
corresponding mobile reference entries. Describe Extensions and MCP as reference
actions, not management or connection actions. Keep accessible labels stable and
provide the supplementary text as accessible descriptions.
Use regular font weight for both action labels and descriptions.

In the Extensions and MCP submenus, keep each item's description to one line
with an ellipsis when it overflows. Preserve the full text in the native title.

Keep the existing dropdown, drawer, and button primitives. Add a small private
CSS Module for icon tiles, text hierarchy, row spacing, and a responsive menu
width. Keep the layout compact with 32px icon tiles, 52px minimum rows, and a
320px menu capped to the viewport. Remove the separator above Skills and inset
the remaining separators to align with the icon tiles. The menu background,
border, shadow, and portal integration remain owned by the existing primitive.
Use existing semantic color tokens; no new theme,
dependency, or public API is needed. Remove the obsolete Plan icon wrapper rule
from the shared stylesheet without otherwise restyling it.

Present the confirmed Plan state with a decorative switch-shaped indicator.
Keep the row as the single interactive control: desktop retains its menu checkbox
and mobile retains its pressed button. Do not nest another button or switch,
introduce optimistic state, or give the row a special accent or background.
In forced-colors mode, use Canvas/CanvasText system colors and a visible outline
so the thumb remains visible and its position distinguishes both states.

## Consumers and constraints

The shared composer serves browser desktop, mobile, and embedded hosts including
the VS Code companion. Both dropdown and drawer paths must retain their existing
actions and keyboard or touch behavior. Narrow browser coverage does not prove
the VS Code host itself works; report that distinction in verification results.

## Validation and acceptance

- Run the AddMenu and ChatEditor unit tests and focused composer browser tests;
  confirm labels, file selection, references, Skills, and Plan still work. Check
  checked, unchecked, and busy Plan states and activation through the indicator.
- Capture and inspect the actual menu in dark and light themes and the mobile
  drawer using the existing mock daemon. Label evidence as simulated backend UI
  validation, not real daemon or Git operation validation.
- Check leading icons and label alignment at desktop and narrow widths without
  menu overflow. Run the repository build and typecheck.
- Keep the component, private styles, both translations, affected tests, and both
  design documents synchronized. Store local evidence under `.qwen/e2e-tests/`.

## Open questions

None for this version. This implements the reference's internal organization;
the existing menu background and border stay intact, and Plan is not highlighted.
