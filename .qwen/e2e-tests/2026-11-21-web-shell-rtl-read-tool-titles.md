# Arabic tool title direction

1. Run `qwen serve`, open Web Shell with Arabic selected, and use an Arabic-first filename.
2. In a captured conversation, inspect ReadFile rows for line ranges, a limit without offset, an offset without limit and a PDF page/range. Each original title should render in an isolated `bdi[dir=ltr]`; the Arabic UI around it should stay RTL.
3. Export the conversation as HTML and verify the plain ReadFile path still renders LTR. Separately, the unit fixture uses a synthetic legacy decorated title with only its file/read-range preview and verifies isolation there too; the current exporter does not emit that decorated title.
4. Compare a Grep title from an invalid invocation with an explicit prose description matching the Grep framing. It should render `dir=auto`, while a daemon-generated Grep title with a relative path outside the workspace stays isolated LTR.

Baseline: the global `qwen` executable is not installed in this host. Use the repository's focused ToolGroup test and the exact source formatter as the baseline witnesses instead.

## Producer-authored WriteFile, Edit, and ListFiles titles

- In the same Arabic conversation, create an Arabic-first path through both
  WriteFile and an Edit with an empty `old_string`. List a deeply nested
  Arabic-first directory. The compact and expanded tool headers must isolate
  the daemon's original description with `bdi[dir=ltr]`, including the
  middle-elided ListFiles path.
- Approve a pending edit: permission display metadata and status-only updates
  must not replace the tool call's classified title. An explicit prose
  replacement remains `dir=auto` even when its text matches the machine title.
- Replay an older transcript and open an HTML export without provenance:
  preserve args-derived path direction and the existing ReadFile/Grep fallback.

The exact pre-fix formatter classifies each of the three new machine examples
as prose. With ACP provenance it classifies all three as machine text. The
emitter fixtures build the real tools, the adapter fixture covers ACP
normalization and reduction, and the ToolGroup fixture asserts the actual DOM.
