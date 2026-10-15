# Web Shell Composer Add Menu Implementation Plan

**Design:** `docs/design/web-shell/web-shell-composer-add-menu.md`

## Scope

Add an opt-in `+` toolbar menu to the Web Shell composer without changing daemon APIs or message contracts.

## Decisions

- Reuse the toolbar action lists; `addMenu` stays absent from embedder defaults.
- Append `addMenu` to standalone defaults and opt split-view panes in explicitly without removing existing controls.
- Keep five one-line top-level submenu entries: Add file, Reference file, Extensions, MCP, and Skills.
- Add file chooses attachment or workspace upload before opening the native picker.
- Reference file opens on the workspace root, supports folder browsing, and uses workspace-wide glob search for name queries.
- Share the existing built-in `@` providers instead of duplicating their availability, escaping, caching, or insertion rules.
- Keep MCP references at server scope because resource references are not consumed on the Web Shell backend path.
- Append reference chips without replacing selected draft text; prepend skills without replacing the draft or existing chips.
- Support both CodeMirror and the touch textarea backend.
- Keep menu navigation pointer-only; add no feature-specific keyboard handlers.

## Implementation

- [x] Extract built-in reference providers and helpers to `useAtMentionSources.ts` while preserving `useAtMentionMenu.ts` behavior.
- [x] Add the opt-in toolbar action and standalone-host enablement.
- [x] Add the `+` trigger and Add file destination submenu.
- [x] Add root folder browsing and literal-safe workspace file search.
- [x] Add extension and MCP server submenus.
- [x] Add bounded, scrollable Skills submenu and prepend behavior.
- [x] Add English and Chinese copy.
- [x] Keep the search input mounted when focused and let an unfocused hover submenu close normally.
- [x] Preserve `@` search routing while enabling directory drill-in only in the Add menu.
- [x] Distinguish loading, empty, and failed submenu states without custom keyboard navigation.
- [x] Add focused unit and integration coverage.

## Verification

- [x] Final regression files: 7 files, 385 tests passed.
- [x] Full Web Shell suite: 204 files, 4374 tests passed.
- [x] ESLint passed for all touched TypeScript files.
- [x] Prettier and `git diff --check` passed.
- [ ] Real-device touch flyout check remains manual, as called out in the design.

Repository-wide typecheck is currently blocked by unrelated pre-existing CLI session-PR errors, a duplicate property in a core test, and the approval-mode type error in `packages/web-shell/client/App.tsx`.
