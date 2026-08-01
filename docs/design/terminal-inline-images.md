# Terminal Inline Images

## Problem

The interactive CLI discards model `inlineData` image parts at the
`Turn`-to-TUI boundary. Tool images survive in nested
`functionResponse.parts`, but the tool display reduces them to text
placeholders. As a result, image-generating models and screenshot-producing
tools cannot show their output in the conversation even when the terminal has
an image protocol.

Mermaid rendering already contains Kitty and iTerm2 protocol primitives, but
they are coupled to Mermaid process execution and cannot be reused by normal
messages.

## Scope

This change provides the first, render-and-forget slice of issue #8090:

- extract terminal capability detection, protocol encoding, image sizing, and
  Kitty placeholder generation into a shared utility;
- render inline model images without changing the existing text stream
  contract;
- render images nested in successful, failed, or cancelled tool responses;
- restore both model and tool images from recorded sessions;
- show a deterministic text placeholder when an image cannot be rendered.

Kitty image deletion, resize-driven replacement, scroll lifecycle management,
and terminal cell pixel queries are intentionally deferred. They require a
separate lifecycle owner above individual history items.

## Data Flow

### Model output

`ServerGeminiContentEvent.value` remains the concatenated text string consumed
by all existing clients. When a response chunk also contains image
`inlineData`, the event gains an optional ordered `parts` field containing only
displayable non-thought text and image parts.

Only the interactive TUI reads `parts`. It buffers text and image entries in
their original order and represents an image as an otherwise normal `gemini` or
`gemini_content` history item. Runs normally remain in the dynamic region until
a response boundary, allowing a fresh retry or model fallback to discard the
uncommitted failed attempt. Existing size- and height-driven incremental commit
boundaries still apply to very long output. Text-only events keep their exact
runtime shape, so existing consumers are unaffected.

The unchanged `value` contract continues to serve core client aggregation, loop
detection, non-interactive output, daemon/channel bridges, ACP, SDK, Web UI,
VS Code, and desktop consumers. The optional field is additive and does not add
a new event discriminant that those consumers would need to handle.

Recorded assistant messages already retain their original parts. Resume logic
reconstructs ordered text/image runs from those parts instead of flattening the
images away.

Because encoded images are much larger than ordinary history text, UI memory
compaction drops payloads from old assistant image items while retaining the 20
most recent items. Cleared images leave a visible marker instead of becoming a
blank history row. Tool image payloads participate in the existing tool-result
compaction limit as well.

### Tool output

Tool media is stored in `functionResponse.parts`. A CLI-only extractor reads
image `inlineData` from both top-level and nested response parts. Live scheduler
mapping and resume mapping attach the extracted images to the existing
`IndividualToolCallDisplay`.

Tools carrying images are rendered individually even when their text-only form
would normally be collapsed into a read/search summary. `ToolMessage` then
routes each image through the same `TerminalImage` component used for assistant
messages.

## Rendering

The shared renderer:

1. validates bounded base64 input before decoding;
2. verifies a supported image header and reads its pixel dimensions;
3. calculates a cell bounding box from the available width and a conservative
   default cell aspect ratio;
4. selects Kitty or iTerm2 only for a positively identified local TTY;
5. returns either a protocol render result or a text placeholder.

Kitty-capable terminals use virtual placement plus Unicode placeholders. The
PNG transfer is written through the raw terminal output context, while the
placeholder cells give Ink a stable layout anchor.

iTerm2 OSC 1337 sequences cannot be embedded in Ink text because Ink strips
terminal control tokens. In the default alternate-screen viewport,
`TerminalImage` therefore reserves the calculated rows, measures its
post-layout cell position, and writes the OSC sequence at that visible screen
position while preserving and restoring the user's cursor. If the measured
position is outside the visible viewport, it leaves the text placeholder in
place instead of writing at an unrelated cursor location. Main-screen
scrollback has no reliable absolute origin, so iTerm2 rendering also uses the
placeholder when terminal-buffer mode is disabled.

Detection is disabled under tmux, screen, and SSH because protocol forwarding
cannot be assumed. Kitty and Ghostty use Kitty virtual placements; iTerm2,
WezTerm, and Warp use OSC 1337. Each terminal is selected from its documented
environment markers. Tests can force a protocol through the shared detection
options without changing production detection.

Kitty transfers these images as PNG (`f=100`). Other validated formats render
through iTerm2 where supported and otherwise use the text placeholder.

## Fallback and Accessibility

The fallback format is:

```text
[image: 1024x768 png]
```

When dimensions cannot be verified it becomes `[image: png]`. MIME labels are
derived only from validated `image/*` media types; arbitrary response strings
are never emitted as terminal control data.

Screen-reader mode always uses the text placeholder. Unsupported terminals,
invalid base64, oversized payloads, unsupported formats, and unsafe/off-screen
iTerm2 placement also use the placeholder.

## Test Plan

- Unit-test terminal detection, multiplexers, encoders, base64 bounds, image
  metadata, sizing, and fallback labels.
- Unit-test Kitty raw transfer and iTerm2 measured placement in the React
  component.
- Verify `Turn` preserves mixed text/image/text ordering while keeping `value`.
- Verify the live TUI commits mixed content in order.
- Verify live and resumed tool responses expose nested images.
- Verify resumed assistant history preserves text/image ordering.
- Verify memory compaction clears old assistant and tool image payloads.
- Re-run existing Mermaid renderer and component tests after extraction.
- Manually exercise supported and unsupported terminal paths using a generated
  PNG fixture.
