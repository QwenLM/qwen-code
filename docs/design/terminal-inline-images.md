# Terminal Inline Images

## Problem

The interactive CLI drops model `inlineData` image parts at the
`Turn`-to-TUI boundary. Images nested in tool `functionResponse.parts`
survive in model history, but the tool display reduces them to text. As a
result, image-generating models and screenshot-producing tools cannot show
their output in the conversation.

PR #8217 introduced the path-based `display_image` tool and established the
project's terminal image infrastructure: `TerminalImage`,
`terminal-image-renderer`, native Kitty/Ghostty placement, and `chafa`
symbol output. This change extends that infrastructure to in-memory model and
tool image parts instead of adding another renderer.

## Scope

This is the render-and-forget slice requested by issue #8090:

- preserve ordered text and image parts on content events without changing the
  existing concatenated `value` contract;
- render live assistant PNGs and restored successful tool PNGs through the
  #8217 component and renderer;
- render PNGs nested in successful tool responses;
- keep text/image ordering across retry, model fallback, cancellation, stream
  boundaries, and goal-state events;
- bound retained image payloads during UI history compaction;
- render at most four images per assistant output or tool row and collapse the
  remainder into a `[+K more images]` marker;
- show a deterministic text placeholder when an image cannot be rendered.

Kitty deletion, resize-driven replacement, terminal cell pixel queries, and
global scroll lifecycle ownership remain out of scope and are tracked in
#8520.

## Data Flow

### Model output

`ServerGeminiContentEvent.value` remains the concatenated text consumed by
existing clients. When a response chunk contains image `inlineData`, the
event also carries an optional ordered `parts` field containing displayable
non-thought text and image parts.

Only the interactive TUI reads `parts`. It stages text and image history
items in their original order. A fresh retry or model fallback discards the
failed attempt's staged output, while a normal response boundary commits it.
The TUI admits at most four images for one assistant output and represents any
remaining image parts with a small overflow marker. Visible status rows end the
current assistant display block, so later text starts with the normal assistant
prefix instead of being attached to the status row as a continuation.
Text-only events keep their existing runtime shape, so non-interactive output,
SDK, ACP, daemon, channel, Web UI, and VS Code consumers continue using
`value` unchanged.

After a thrown stream, staged output remains transient so an explicit retry can
discard the failed attempt. If an out-of-band shell or slash-command item is
added before the next model submit, that item can enter committed history before
the staged output. The next model submit commits the staged output; history
clear, resume, branch, restore, rewind, and Ctrl+L paths discard it instead.

Resume logic reconstructs ordered text/image runs when persisted parts contain
them. Tool responses retain nested image parts in the session record. The
current Core recorder flattens assistant output to text, so live assistant
images are not restored by `--continue`; assistant-image persistence is outside
this slice and tracked in #8521.

### Tool output

Tool media is stored in `functionResponse.parts`. A CLI extractor reads image
`inlineData` from top-level and nested response parts. Live scheduler mapping
and resume mapping attach the images to the existing
`IndividualToolCallDisplay`. Each successful tool row keeps the first four
images and an overflow count for the rest. Failed and cancelled tool records
currently do not carry inline image parts from Core, so their image handling is
defensive rather than a supported output path in this slice.

Tools carrying images render individually even when their text-only form would
normally collapse into a read/search summary. `ToolMessage` routes the images
through the same `TerminalImage` component used by assistant messages.

## Rendering

The existing #8217 file-path entry point is unchanged. The shared renderer
adds an in-memory PNG entry point that:

1. validates bounded base64 before decoding;
2. verifies the PNG signature and IHDR dimensions;
3. rejects payloads above 8 MiB, dimensions above 1,000,000 pixels, or images
   above 64 million total pixels;
4. reuses the existing terminal sizing and bounded render cache;
5. uses native Kitty placement in direct Kitty/Ghostty sessions;
6. passes PNG bytes to `chafa` over stdin in other supported environments;
7. returns a text placeholder when rendering is unavailable.

No temporary file is created. The inline payload is never used as a command
argument, and `chafa` receives the same allowlisted environment as the
path-based renderer.

The fallback format is `[image: <width>x<height> png]`. Invalid PNG data
becomes `[image: png]`; unsupported image MIME types retain their sanitized
format label, such as `[image: jpeg]`. Screen-reader mode always uses the text
placeholder and emits no raw image sequence.

The same encoded-length limit is applied before inline data enters CLI history
or tool-display state. Payloads that exceed the renderer's 8 MiB decoded-image
budget are dropped before rendering and do not produce a placeholder.

The first slice renders validated PNG data only. Other image MIME types remain
visible as deterministic placeholders rather than entering a second protocol
or decoding path.

## Memory

Encoded images are much larger than ordinary history text. UI compaction drops
payloads from old assistant image items while retaining the 20 most recent
items. Cleared images leave a visible marker instead of becoming blank rows.
Tool image payloads participate in the existing tool-result compaction limit.
The four-image admission cap also bounds synchronous Kitty/chafa rendering for
each assistant output and tool row.

## Test Plan

- Keep every #8217 renderer and `display_image` test green.
- Verify inline PNG validation, Kitty rendering, `chafa` stdin rendering,
  screen-reader output, and unavailable-renderer placeholders.
- Verify `Turn` preserves mixed `text -> image -> text` ordering while
  retaining the old `value` and text-only event shape.
- Verify live TUI ordering across retry, fallback, cancellation, stream
  boundaries, and goal-state events.
- Verify live and restored successful tool responses expose nested images.
- Verify the resume parser preserves assistant text/image ordering for records
  that already contain persisted parts; the current recorder's assistant-image
  persistence gap remains outside this slice.
- Verify live assistant and successful tool output enforce the image cap and
  expose the overflow count; oversized payloads are dropped before UI history.
- Verify memory compaction clears old assistant and tool image payloads.
