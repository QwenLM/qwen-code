# Web Shell file previews

## Context

The review tab currently expands source diffs but cannot open rendered output.
Workspace HTML artifacts already open in a sandboxed iframe, while Markdown
artifacts open as source text. The review tab also opens its optional file tree
by default when the panel is wide.

## Design

- Add a file-preview tab to the existing right panel. Review rows always expose
  a **Preview** action for HTML and Markdown paths. The tab retains the
  workspace actions that own the review, so split-pane reviews read from the
  correct workspace runtime.
- Keep the row itself responsible for expanding its diff. The separate Preview
  action does not toggle the diff.
- Share workspace-file loading across HTML, Markdown, and source previews.
  HTML remains isolated in the existing sandboxed iframe. Markdown uses the
  Web Shell Markdown renderer. Other artifact files retain the read-only source
  view.
- Initialize the review file tree as closed. Users can still open it with the
  existing toolbar control.

No daemon or SDK protocol changes are required.

## Test strategy

- Pure helper tests cover rendered-file classification and Markdown artifact
  preview-content lookup alongside HTML.
- Per request, do not run browser, E2E, visual, or DOM-rendering UI tests.
- Run Web Shell lint, typecheck, and build checks.
