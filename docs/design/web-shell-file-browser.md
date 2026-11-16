# Web Shell file browser

[English](web-shell-file-browser.md) | [简体中文](web-shell-file-browser.zh-CN.md)

## Problem and current state

The right extension area offers file changes but cannot browse workspace files.
The requested interface adds a Files entry beside the existing actions, with the
selected file on the left and a persistent directory tree on the right.

## Proposed solution

Add an opt-in `files` right-panel item and a workspace-owned `files` tab. Enable
it in the standalone page. The empty-state action and add menu open or activate
one Files tab per workspace. Reuse existing panel sizing, closing, fullscreen,
and persistence behavior. Before selecting a file, show only the full-width tree.
Selecting a file opens the two columns with about 70% for content and 30% for
the tree, without rebuilding the tree; subsequent
file selections keep it visible.

Use `@pierre/trees` for the read-only tree and `@pierre/diffs` File for read-only
source rendering. Retain existing Markdown, HTML and image previews. Markdown
and HTML default to rendered preview with a source toggle. Other files use the
existing supported-file/error behavior. No Git state or editing is enabled.

Load only the root and expanded directories through the existing daemon API.
Keep loaded paths in the Pierre model; directory expansion loads direct children.
Search covers loaded paths only and never fetches search-expanded directories.
Keep the raw filter input unchanged; show an explicit no-match state within loaded
paths. Selection or Escape closes filtering. A nonempty filter consumes Escape
before fullscreen or drawer dismissal; IME composition keeps its native Escape.
Refresh clears directory cache and reloads
the root and selected file, collapsing branches. Hide the filter-scope explanation
and per-directory loading log; show retryable errors, empty directories and
truncated-list warnings only when needed. Never recurse into symlinks.
Files expose a right-click menu for relative/absolute path copying, downloading,
previewing supported Markdown/HTML/images in a separate panel tab, and referencing
the file in the current composer. Reference uses the same tag construction and
inline insertion as the built-in `@` file picker, only for the current workspace.
Reference closes a floating drawer before returning focus to the composer;
the desktop dock stays open.
Downloads reuse the existing bounded, owner-checked byte reader and cancellation.
Both columns scroll independently. The tree scrolls horizontally as a whole,
keeping indentation and complete names at deep levels. Use Pierre’s shadow-root
CSS extension to size the virtual list by its content and prevent label shrinking. A keyboard-accessible draggable separator
uses the shared shadcn resizable primitive to adjust their widths, preserving the
layout across tab switches. Leave 12px below the tree. The tree can be hidden to read content in a
narrow panel without closing the Files tab.

## Ownership and lifecycle

The Files tab captures workspace cwd and ID. Extend the existing artifact owner
guard with directory reads, checking authority before and after requests. Use
workspace-qualified SDK directory reads over REST (including ACP clients) whenever workspace IDs are advertised;
retain the primary route only for legacy daemons. Unavailable, ambiguous,
untrusted or changed owners fail closed. Workspace changes discard late results.
Files panes remain mounted while inactive, preserving selection, expansion,
source/preview mode, filtering, column sizes and scroll position across tab switches. Each pane
checks its own workspace owner even while hidden; closing the tab or losing its
owner discards that state. Only tab workspace identity persists across reloads. A stale persisted owner stays
blocked, but does not hide the action for reopening the current trusted owner. File content loading retains existing size limits and cancellation.

## Scope and decisions

No filesystem mutations, code editing, Git operations, watchers or whole-workspace
search index. Opening files does not add them to model context; the explicit
Reference action inserts a file tag without sending a prompt. Keep existing
review, attachment and file tabs unchanged. Pierre uses Shadow DOM; style its
public variables with Web Shell semantic colors. Use its vanilla entry points to
preserve the package's existing React 18/19 peer range. Pierre is a pinned build-time
dependency: its vanilla implementation is bundled, so published consumers do not
install its React peers (which require 18.3.1 or later).
The explicit `bundledDevDependencies` list seeds license generation without
including unrelated development tools. Bundled dependency licenses and NOTICE
credits ship in the npm package and the VS Code companion notice file.
Tree and source loading have local error boundaries. Failed imports offer a page
reload only in the standalone shell when credentials survive it (or no token is
needed). Embedded hosts and memory-only credentials instead offer Close Files,
without reloading the host or presenting a cached import as a local retry.
Pierre render errors propagate to the local boundary after resource cleanup.
The constructor uses the resolved shell theme; theme changes update it in place. Floating drawers traverse shadow-root tab
stops before Radix's light-DOM focus loop can skip the tree.
Source rendering is virtualized; theme changes update the renderer in place. Pierre
uses a curated Shiki 4.5.0 entry with 33 supported language keys and two GitHub themes
in the lazy preview chunk, while other renderers retain Shiki 1. See the
[follow-up design](web-shell-files-followups.md) for resource selection and budgets; files over 10,000 lines or 1,048,576 characters use plain
text to bound syntax-highlighting work. Files source previews refuse files above
4 MiB before reading their content, and apply the same cap to chunked fallback
reads. Users can download these files from the file menu. Files translations are
excluded from the transcript-only bundle. The actual shadow tree and file menu
have accessible names.

The file menu also offers Preview for `.xlsx` files, reusing the shared spreadsheet preview in a separate workspace-scoped file tab. Opening the same file again reuses that tab; returning to Files retains the tree and inline selection. Other Excel formats retain the existing download-only behavior.

## File changes assessment

Pierre FileDiff can render the existing before/after text, unified/split views,
line numbers and inline changes. It can replace the visual renderer later. The
input may contain full snapshots, unified patches or partial edit fragments.
Partial fragments must not be presented with full-file line numbers, and repeated
edits to one file must retain their recorded segments. The current file-changes
feature additionally owns tool-call grouping, aggregated
line statistics, recorded-turn versus latest-workspace semantics, file opening,
downloads and missing/binary file handling. Keep those responsibilities intact.
Migrating the renderer requires separate validation of CodeMirror merge behavior,
large/truncated changes, cancellation, themes and wrapped lines. This change only
records the assessment; it does not migrate review rendering or connect Git.

## Affected areas

- Artifact panel, customization, standalone entry, translations and README.
- App tab opening, persistence and workspace ownership wiring.
- A workspace file browser, Pierre source renderer and focused tests.
- Guarded artifact workspace directory reads and authority tests.
- Browser E2E tests using the existing mock daemon, explicitly labeled as mock.

## Validation and acceptance criteria

1. Files appears beside File changes; initially only the tree is visible. Selecting
   a file opens content on the left and the tree on the right.
2. Directory expansion loads direct children and reuses cached results. Deep
   paths and long names remain readable through horizontal tree scrolling.
3. Selecting files changes content while keeping the tree visible.
4. Markdown renders as a document and switches to highlighted read-only source.
5. Filtering preserves input, shows no matches explicitly and does not load
   directories. Refresh, empty/error and incomplete-list states are visible.
6. Right-click copy paths, byte download, preview tabs and `@` references work.
7. Untrusted/changed workspace owners and late responses cannot leak content.
8. Tab switches retain file-browser state; closing/reopening, page reload tab
   restoration and narrow layouts remain usable.
9. Existing review and attachment behaviors remain covered.
10. File browsing and filtering enter the PR browser smoke gate. Focused ownership,
    persistence and transport tests, build, typecheck and inspected browser screenshots provide evidence.

## Open questions and risks

Trees is Beta; pin the version and validate actual expansion/model-reset behavior.
Git badges, review migration, live watchers and global search are future work.
