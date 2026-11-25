# Web Shell Native CSS `@scope` Isolation

[English](web-shell-native-at-scope.md) | [简体中文](web-shell-native-at-scope.zh-CN.md)

## Problem

Embedded Web Shell bundles previously isolated component CSS by prepending a 198-character `:where([data-web-shell-root][data-web-shell-shadcn], [data-web-shell-portal-root][data-web-shell-shadcn], [data-web-shell-root][data-web-shell-shadcn] *, [data-web-shell-portal-root][data-web-shell-shadcn] *)` prefix onto every selector branch in the stylesheet.

In embedded hosts, this caused two compounding style-recalculation bottlenecks during composer interactions (such as selecting all text and deleting it):

1. **Zero fast-reject selector matching and double scoping**: The descendant `*` inside `:where(...)` disabled Blink's ancestor Bloom filter (`fastReject = 0`) and doubled up on already-scoped preflight/scrollbar universal rules (`*`, `::before`, `::after`, `::backdrop`, `::-webkit-scrollbar`). It also inflated the injected stylesheet by ~1.4 MB.
2. **Whole-subtree `:has()` invalidation**: Four shadcn UI utilities (`group-has-*` in `field.tsx`, `checkbox.tsx`, `alert.tsx`, and `alert-dialog.tsx`) compiled to `:is(:where(.group/...):has(...) *)`, which creates a `WholeSubtreeInvalid` invalidation set in Blink. When combined with host `:has()` rules, editing inside `.cm-content` / `.cm-selectionLayer` invalidated ~1,260 elements up to the document app root three times per select-all + delete (~360–400 ms total `UpdateLayoutTree`).

## Solution

1. **Wrap component CSS in native `@scope`**:
   - Scope component style rules inside `@scope ([data-web-shell-root][data-web-shell-shadcn], [data-web-shell-portal-root][data-web-shell-shadcn]) { ... }` in `packages/web-shell/vite.lib.config.ts` (shared by the `index`, `transcript`, `managed-host`, and lazy `xterm.css` outputs).
   - Hoist global declarative at-rules (`@charset`, `@import`, `@font-face`, `@property`, `@keyframes` including `@keyframes` nested inside `@media` / `@supports`) to the top level outside `@scope` while preserving their `qwen-web-shell-` / `--qwen-web-shell-` prefixes.
   - Keep top-level `@layer` blocks (such as Tailwind's `@layer properties` fallback) at top level with their inner rules wrapped in `@scope`.
   - Rewrite `:root` / `:host` and pre-scoped `:is([data-web-shell-root]:where([data-web-shell-shadcn]), [data-web-shell-portal-root]:where([data-web-shell-shadcn]))` rules to `:scope`, preserving `(0, 1, 0)` specificity for preflight resets without double scoping.
   - Because unprefixed selectors inside `@scope` implicitly target descendants (`:where(:scope) <sel>`), emit a zero-specificity `:where(:scope)` compound branch alongside each non-`:scope` selector so classes placed directly on `[data-web-shell-root]` (e.g. `.app`, `.themeDark`, `.appChatEmpty .content`) and their descendants continue to match without universal `*` rules.
2. **Replace `group-has-*` utilities that emit `:has(...) *`**:
   - `FieldDescription`: `group-data-[orientation=horizontal]/field:text-balance` (reading `data-orientation` directly on `Field`).
   - `Checkbox`: `group-data-[disabled=true]/field:opacity-50` (consistent with `FieldLabel` and `FieldTitle`, alongside `disabled:opacity-50`).
   - `Alert` / `AlertTitle`: move column placement to `Alert` via direct child selector `has-[>svg]:[&>[data-slot=alert-title]]:col-start-2`.
   - `AlertDialogHeader` / `AlertDialogTitle`: move column placement to `AlertDialogHeader` via direct child selector `sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:[&>[data-slot=alert-dialog-title]]:col-start-2`.

## Constraints & Tradeoffs

- Embedded library CSS now relies on native CSS `@scope` (Chrome/Edge 118+, Safari 17.4+, Firefox 146+).
- Standalone app builds (`vite.config.ts`) and host stylesheets are unchanged; hosts with broad `div:has(...)` rules still benefit ~45× from this change and can reach sub-millisecond style recalculations by replacing those host rules with explicit classes or data attributes.

## Verification

- Build artifact tests in `packages/web-shell/client/build-artifact.test.ts` assert that both `dist/index.js` and `dist/transcript.js` wrap all component rules in `@scope`, hoist `@font-face` / `@property` / `@keyframes`, emit no legacy `:where([data-web-shell-root][data-web-shell-shadcn]...` prefixes, and emit no `:has(...) *` selectors, and that lazy `terminal-runtime` CSS is also wrapped in `@scope`.
- Verified in Chromium and WebKit across Light DOM, Portal root, and Shadow DOM (`adoptedStyleSheets`) for host isolation, root-element classes, dark theme, KaTeX fonts/borders, animations (including `@media (prefers-reduced-motion: no-preference)` keyframes), and all four updated UI primitives.
