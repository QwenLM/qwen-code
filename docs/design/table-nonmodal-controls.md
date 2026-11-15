# Nonmodal table controls

[English](table-nonmodal-controls.md) | [简体中文](table-nonmodal-controls.zh-CN.md)

## Problem

Opening Copy or Table density applies document-wide pointer suppression and
scroll locking. These inherited changes trigger expensive style recalculation
over a large table. Controlled experiments identified the interaction between
modal menus and generated CSS scope matching; reducing the rendered row count
only masks part of the cost.

## Scope and decisions

Use the existing nonmodal Radix dropdown primitives for table commands and
filter operators. Keep the shared primitives' defaults and CSS isolation intact.

| Surface                             | Behavior                                                   |
| ----------------------------------- | ---------------------------------------------------------- |
| Copy and Table density              | Explicit nonmodal dropdowns                                |
| Custom columns and column filters   | Existing nonmodal popovers                                 |
| Text and numeric filter operators   | Nonmodal dropdown radio groups instead of modal Select     |
| Column context menu and row details | Existing local menu and inline expansion                   |
| Tooltips                            | Existing nonmodal tooltips                                 |
| Cell value and fullscreen           | Retain modal dialogs, their backdrop and focus containment |

Operator menus retain the current value, translated labels, filter draft,
portal owner and overlay stacking. Keyboard navigation and focus restoration
must work with light and Shadow DOM portals. Selecting an operator keeps the
outer filter open; Escape first closes the operator menu. Outside interactions
can dismiss a tool menu and operate the next table control in one click.
Interactions on the same trigger must not also dismiss its closing menu when
reopening during the exit animation; preserve normal Escape focus restoration.

True dialogs intentionally make background content unavailable. Removing their
modality would change their interaction contract. This change does not optimize
their CSS or alter the generated stylesheet.

## Validation and acceptance

- Opening table tool menus or operator menus does not suppress body pointer
  events, hide the table from accessibility, or add a scroll lock.
- Inside fullscreen, opening these controls preserves the dialog's existing
  scroll lock rather than adding another one.
- Copy text/Markdown, density choices, text/numeric operators, applying filters,
  outside dismissal, arrow keys, Enter, Escape and focus restoration work.
- Inline/fullscreen and light/Shadow DOM paths retain portal styling and work
  with the supported React ref wrappers.
- Focused unit tests and browser E2E exercise behavior rather than enforcing a
  machine-dependent timing threshold. Repeat the mock-daemon performance
  scenario separately and distinguish it from live service validation.
- Inspect screenshots, build, typecheck and review the complete diff.
