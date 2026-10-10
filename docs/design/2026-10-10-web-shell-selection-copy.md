# Web Shell selected reply copying

[English](2026-10-10-web-shell-selection-copy.md) | [简体中文](2026-10-10-web-shell-selection-copy.zh-CN.md)

## Problem and scope

Reply copy currently copies the entire Markdown source. Users reading a long reply need to copy only selected content, either as visible text or Markdown. Native browser copying offers no explicit choice and may include code and table controls.

This change adds a selection popover to a single assistant reply body in interactive mode. It does not change whole-reply copying, native keyboard copying, user messages, thinking blocks, document exports, or mobile selection menus. It writes text, not HTML rich text.

## Proposed behavior

After a mouse selection finishes inside one reply, show two actions near the selection: **Copy plain text** / **Copy Markdown** (Chinese: **复制纯文本** / **复制 Markdown**). Preserve selection while interacting with the popover. Close on empty or external selection, content changes, scrolling, Escape, outside interaction, and successful copying. Failed clipboard writes keep the menu available for retry.

Both endpoints must belong to the same reply body. Releasing the mouse outside the body still opens the menu when the drag started inside it and the range stays within it. Cross-message selections keep normal browser behavior. Streaming replies do not offer the menu until settled. Keyboard selection retains native copying and does not open this menu. Touch selection retains the native browser menu.

Drags starting in an advanced table retain its existing rectangular cell selection, toolbar actions, and native copy shortcut. They do not open the reply selection menu. Native text selections spanning a table from surrounding reply text can still be copied by the reply menu.

## Implementation and decisions

Use the existing scoped Radix popover, virtual selection anchor, portal container, and clipboard fallback helper. A small component owns selection lifecycle, snapshotting the selected text before menu focus can change it. Track mouse gesture ownership in the document capture phase using the composed event path, so outside releases work and portal menu clicks are not treated as new selections. Feature-detect ShadowRoot selection APIs and reject ranges outside the body.

Clone only intersecting DOM nodes, trimming boundary text while retaining ancestors. This preserves formatting when selecting part of a heading, bold span, list item, or code block. Explicitly exclude code headers and table controls, operation columns, hidden filler cells, and expanded row detail panels. Omit list markers for ancestors whose own content is not selected, while retaining selected nested items. Convert the cleaned semantic subtree to plain text with boundaries before and after blocks, and to Markdown with the Turndown version already used by this repository, declared directly by Web Shell. Add GFM table, task-list checkbox state, and strikethrough rules. Markdown normalizes syntax rather than reproducing the exact original spelling. No source-offset mapping is introduced: rendered transformations and visible sorted/filtered tables must match what the user selected.

Preserve code indentation and language, close code fences safely, escape table pipes, and pad partial table rows into a valid Markdown table. A selection without table headers gets empty headers; never add unselected data. Custom renderers without standard semantic HTML and rendered diagrams can only expose the semantics present in their DOM; reproducing their original source is outside this change.

Keep selected images as Markdown images and use their alternative descriptions in plain text. A fully selected KaTeX expression uses its existing TeX annotation once: plain text contains the expression source, and Markdown wraps it with inline or display math delimiters. Partial expressions copy only selected visible text, without adding unselected source. Clipboard fallback focuses the chosen menu action and stays inside its Radix layer, including ShadowRoot layers and host dialogs outside a ShadowRoot; failures restore the original selection for retry.

## Affected files

Web Shell assistant rendering, code/table copy exclusion attributes, a selection menu component and conversion utility, bilingual UI strings, focused unit and browser tests, package dependencies and lockfile. The transcript build substitutes a plain body wrapper for the interactive selection component, so the menu and Turndown are absent from the exported document entry. No daemon or core changes.

## Validation and acceptance

Dry-run against the global qwen Web Shell, then run the local built Web Shell with fixed mock-daemon replies and real browser clipboard writes. Validate mouse partial selection, both clipboard results, partial bold/link/heading/list/code/table selections, nested-list subsets, compact DOM block boundaries, keyboard exclusion, menu repositioning after reselection, real ShadowRoot and host-dialog clipboard fallback, transcript bundle size, cross-paragraph boundaries, repeated text, UI exclusion, dismissal and clipboard failure, whole-reply copy, Chinese labels, and scoped portal rendering. Check React 18-compatible ref paths, build, typecheck, focused tests, and review the full diff twice.

The selected content alone must be copied, Markdown must remain parseable with selected formatting, pure text must retain useful line breaks, and standard copying must continue working. Screenshots are evidence of the mocked frontend only, not real model or Git operations.

## Open questions

None. The requested “formatted content (markdown)” is interpreted as Markdown text; HTML rich-text copying is a separate feature.
