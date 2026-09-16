# Web Shell Composer Add Menu

## Problem

The composer can already do a lot of "add something to this message" work, but almost all of it has no visible entry point. Files must be dragged in or pasted. Referencing a workspace file requires knowing to type `@`. Invoking a skill requires knowing to type `/`. A user who does not know a capability exists has no way to discover it.

There is a related gap behind this one: the repository already contains a consolidated "more actions" surface in the composer, but it only renders on touch-like devices. On desktop it does not exist at all, so desktop users have no capability list of any kind.

## Goal

Give the composer a `+` button at the front of its toolbar that gathers the "add to this message" capabilities which currently lack a visible entry point.

The `+` is an **entry point, not a capability**. It surfaces what already exists.

## Design

### Positioning

- **Front-end only.** No new backend capability, no daemon route changes, no message-structure changes.
- **Additive.** Existing toolbar controls (model, approval mode, voice, workspace, git branch, context usage, width) keep their current position and behavior.
- **Off by default, via the toolbar item list.** Web Shell already lets the host declare which built-in toolbar controls to render. `addMenu` joins that list as an opt-in identifier and is absent from the default list, so existing embedders see no change.
- The standalone host appends `addMenu` to the context-sensitive defaults so empty-state Git controls are preserved. Split-view panes opt in through their pane list and omit only the width control because pane sizing owns their width.
- **One group only: "Add to message".** An earlier draft also carried a "this task's context" group (context usage, session recap, Goal, shell mode). It was removed as unrelated to what `+` means. Management surfaces (MCP servers, tools, agents, settings) stay out deliberately — they already have sidebar entry points, and repeating them turns a discoverability fix into navigation redundancy.

### Menu contents

One group, five items, all of which expand into submenus.

| Item             | Description | Behavior                                                                            |
| ---------------- | ----------- | ----------------------------------------------------------------------------------- |
| Add file ▸       |             | Submenu; choose "Attach to message" or "Upload to workspace", then pick local files |
| Reference file ▸ |             | Submenu; searches workspace files by name; inserts a reference                      |
| Extensions ▸     |             | Plain submenu list with descriptions; inserts an enabled extension reference        |
| MCP ▸            |             | Plain submenu list; no filter; inserts an MCP server reference                      |
| Skills ▸         |             | Submenu; lists skills; prepends the skill's invocation to the front of the input    |

**Why one file entry, not two.** Two adjacent top-level entries that both start with "pick a local file" are hard to distinguish. One "Add file" submenu keeps the main menu compact while making the destination explicit before the native picker opens.

All five top-level rows are one line. The submenu contents provide the needed detail.
Below the small-screen breakpoint, menus narrow and secondary descriptions hide so adjacent submenus fit without horizontal clipping.

### Layout and interaction

- The trigger is an icon-only button, first built-in control in the toolbar row, after the host's toolbar-start slot.
- **`+` visibility is decided by the host toolbar item list alone.** When `addMenu` is in the list, `+` is present; when not, it is absent. It does not disappear because the five inner capabilities are all unavailable in the current workspace — that would make the entry point flicker across workspace switches and defeat discoverability precisely when it is needed most. If the host has opted in but every inner capability is unavailable, `+` opens to an empty-state row explaining that no add actions are available here.
- All top-level items are one line. Roughly six rows total for five items plus a separator.
- Submenus open as a **separate flyout to the right of the row on hover**, not as in-place expansion. Expanding in place makes the panel tall and hides the whole picture.
- Long lists inside a submenu scroll rather than growing past the viewport.
- **The menu must never lie.** An item either works when clicked or is not shown, or is shown disabled with a stated reason. Silent no-ops are the primary failure mode this design guards against.
- Searchable submenus distinguish loading, empty, and failed states. The file search input receives focus after click opening, but hover opening does not steal composer focus; the input has an accessible name.
- After a file attachment or reference is selected, focus returns to the composer input instead of the `+` trigger. A synchronous reference is appended to the draft and leaves the caret after the tag so subsequent typing follows it.
- Switching tasks or workspaces, or disabling the composer, closes the menu and discards any pending native file selection so stale results cannot cross composer owners.
- **Skills prepend, they do not replace.** Selecting a skill inserts its invocation at the very beginning of the input; anything the user has already typed, and any reference chips already inserted, are preserved and follow after the invocation. This holds whether the draft is empty or not, and removes the "disable Skills on non-empty draft" branch an earlier draft carried.
- **Keyboard navigation is not supported by this feature.** The implementation adds no keyboard handlers, navigation rules, or keyboard-specific focus restoration.

### Files

| Area                       | File                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| Menu itself                | new `client/components/composer/AddMenu.tsx`                      |
| Wiring and enablement      | `client/components/ChatEditor.tsx`                                |
| Reusable reference sources | new `client/hooks/useAtMentionSources.ts`, consumed by both menus |
| Copy                       | `client/i18n.tsx`                                                 |

`ChatEditor.tsx` has grown large enough to be a signal, but this change does not restructure it — it only guarantees the new menu does not land inside it.

## Constraints established during investigation

These are facts about the current system that shape the design, and each one rules out an otherwise obvious implementation.

1. **References are text plus display metadata, and the kinds differ in what they actually do.** A referenced extension really does get its context injected into the turn. A referenced MCP server injects an advisory note. A reference to a specific MCP **resource** is not processed by the backend at all on the Web Shell path — it reaches the model as literal text.
   → MCP stops at the server level. That is not a simplification, it is the only form that works; offering resource drill-down would mean shipping a menu item that does nothing.
2. **A referenced workspace file is likewise not expanded into content** — the model still has to read it. Copy must not imply the file's contents were delivered.
3. **A skill invocation must sit at the very beginning of the input to take effect.** The insertion strategy owns this: selecting a skill prepends the invocation to the front of the input, leaving already-typed text and already-inserted reference chips intact after it. That is what makes disabling Skills on a non-empty draft unnecessary — the constraint is honored by where the insert lands, not by refusing to insert.
4. **Attachments and uploads are two existing lanes** with their own preconditions (host flag, daemon capability, workspace trust). The menu reads the results those checks already produce rather than re-deriving conditions, so the `+` menu and the `@` panel can never disagree about the same file.
5. **File referencing needs both browsing and workspace-wide search.** The submenu opens on the current directory and lets users enter folders, but directory browsing alone is not viable at real file counts. Name queries use the existing global search path and are treated as literals because file names can contain pattern metacharacters.
6. **Inserting must never clobber existing input.** Text already typed and chips already inserted survive every insert. This rules out the whole-input replacement approach that other features use safely only because their input is guaranteed empty.
7. **Sharing providers must not change the existing `@` panel.** Directory drill-in is enabled only for the `+` file submenu; `@` continues to use workspace glob search whenever that action exists.

## Touch

`+` shows the same five items on touch and desktop. Attachment and reference insertion reuse their existing lanes; skill prepend targets CodeMirror on desktop and the native textarea on touch.

**Unverified:** right-side flyouts depend on hover, and touch has none. The menu primitive is expected to fall back to click/focus for non-mouse pointers, but that needs a real-device check. If it fails, touch keeps the single item that does not need a submenu and this section is rewritten.

## Non-goals

- Backend changes, new capabilities, message-structure changes.
- The "this task's context" group.
- An "all commands" entry. Typing `/` already covers it, and dropping this row also removes the draft-state problem that came with it.
- Management pages.
- MCP resource-level references.
- **Subagent targeting.** There is no way to deterministically route a message to a named subagent: no agent kind exists among referenceable objects, agent selection is a model-side tool argument, the session request carries no related field, and no backend path maps user text to an agent. The only available form is natural language begging the model to comply, which guarantees nothing and violates the never-lie rule.
- A host-facing API for registering custom `+` items. Five fixed items this round, gated by the existing toolbar item list mechanism.
- Restructuring the existing touch-only actions surface, or restructuring `ChatEditor`.

## Risks

- The Add file submenu carries a real semantic difference (message-scoped attachment vs workspace-persistent file). Its wording must make both outcomes explicit.
- A new leading control widens the toolbar's minimum width, squeezing the label-collapse budget on narrow split panes. Collapse behavior at small widths needs regression checking.
- The largest piece of work is not the menu: the built-in reference sources are private to one hook and must be lifted into a shared module so both the `@` panel and `+` consume the same source of truth.
- Prepending a skill invocation in front of existing text produces a message the user did not literally type ("/review foo" from a draft that read "foo"). Acceptable — it is exactly what typing `/` first would produce — but the transition must be visible enough that the user notices the shape of their message changed.

## Deferred (found here, not fixed here)

File separately; do not fold into this change.

- The `@` panel already offers MCP **resource** drill-down, which the Web Shell backend ignores. Users believe they referenced a resource; they did not.
- Extension names containing spaces or non-ASCII characters are escaped on write by the client but never unescaped by the backend matcher, so such references can fail silently.
- The file-upload design document claims inserted `@` references are consumed by an existing resolver. That describes the TUI path; the daemon path does not do it.
- Two different touch-detection helpers exist with different semantics, one of which is a re-implementation-and-widening of the other.

## Verification

Behavior-level, not tied to an implementation shape:

1. When `addMenu` is not in the host's toolbar item list, `+` never appears. When it is present, `+` sits at the front of the toolbar and no other control moves.
2. Add file lands on the message as an attachment when the user chooses "Attach to message", and lands on disk plus inserts a reference when the user chooses "Upload to workspace". The three reference submenus insert the correct reference form. Skills prepends the invocation to the very front of the input.
3. File referencing finds a target anywhere in the workspace from a partial name.
4. The MCP submenu inserts a server-level reference for every server, including ones that expose resources, using the same syntax the `@` panel uses for servers without resources; it intentionally does not enter resource drill-down.
5. Selecting a skill with an empty draft yields the invocation followed by a space. Selecting a skill with a non-empty draft yields the invocation, a space, then the previous draft — with any reference chips intact.
6. No insert loses already-typed text or already-inserted references.
7. When an individual capability is unavailable, its item is hidden or disabled with a reason; `+` itself remains visible whenever `addMenu` is in the host's toolbar item list. If every inner item is unavailable, `+` opens to an empty-state row and does not silently vanish.
8. Touch and desktop show the same set, subject to the real-device submenu check.
9. A long submenu scrolls instead of overflowing the viewport.
10. Pointer interaction is covered; keyboard navigation is unsupported and has no feature-specific implementation.
