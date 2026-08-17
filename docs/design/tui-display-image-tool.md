# TUI Display Image Tool

## Goal

Add a model-invocable `display_image` tool that previews an existing PNG in
the interactive terminal UI. The tool is display-only: it does not provide
image pixels to the model and is not available in headless, SDK, screen-reader,
or subagent registries.

## Design

The core tool validates an absolute workspace path, regular-file status, PNG
signature, and an 8 MiB size limit. On success it returns a small structured
display value:

```ts
{
  type: 'terminal_image',
  filePath: '/absolute/workspace/path/image.png',
  mimeType: 'image/png',
}
```

Before returning success, the tool asks a CLI-injected provider whether the
current terminal has an available renderer. Native protocols pass immediately;
the fallback checks that `chafa` is available on `PATH` without rendering the
selected file. If no renderer is available, the tool returns an execution error
so both the TUI and the model know that the image was not displayed.
`llmContent` tells the model to use `read_file` if it needs to inspect the image.
Image bytes and terminal escape sequences never enter model history or the
persisted display value.

`ToolMessage` recognizes the structured value and delegates it to a TUI
component. The component revalidates the path against the current workspace
before reading it. Rendering is prepared during the component's first render
because completed tool rows enter Ink's append-only `Static` region
immediately; an asynchronous state update would be dropped there.
Kitty-compatible terminals use the existing virtual-image and
Unicode-placeholder approach already used for Mermaid diagrams. Other
terminals try `chafa` with symbol output. `chafa` receives only the same
allowlisted environment used by the Mermaid renderer, so API credentials are
not forwarded. If neither path is available, the TUI shows a bounded text
fallback naming the image.

Previews are capped at 72 columns and 24 rows, then reduced further to fit the
available terminal space. An 8-by-16-pixel terminal cell estimate provides a
conservative natural size so small images are not deliberately enlarged. Both
native and `chafa` rendering use the same aspect-preserving dimensions.

The tool is registered only when all of these are true:

- the main config is interactive;
- SDK mode is disabled;
- screen-reader mode is disabled;
- the registry is not being created for a subagent.

Bare mode keeps its existing minimal tool set.

## Compatibility

The first version supports PNG only. Kitty and Ghostty use native image
placement. Warp is intentionally excluded because its Kitty support does not
include the Unicode-placeholder extension used by this renderer, while direct
placement drifts away from Ink content during scrollback and terminal reflow.
Direct iTerm2 placement is also excluded because its inline image protocol is
cursor-positioned and the existing asynchronous Ink path already treats it as
unsafe. Warp, iTerm2, tmux, SSH, and terminals without a native path can still
render through `chafa` when it is installed.

## Security and persistence

Both the tool and renderer use `WorkspaceContext.isPathWithinWorkspace`, which
resolves symlinks and prevents traversal outside registered workspace roots.
The renderer treats restored `resultDisplay` data as untrusted and repeats this
check. Persisted sessions contain only the path and MIME type; if the file no
longer exists, restore degrades to a text notice.

Raw terminal output is generated only by the trusted renderer. Model-controlled
strings and file contents are never written directly to the terminal.
