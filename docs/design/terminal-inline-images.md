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
- render live and restored assistant PNGs through the #8217 component and
  renderer;
- render PNGs nested in successful, failed, or cancelled tool responses;
- keep text/image ordering across retry, model fallback, cancellation, stream
  boundaries, and goal-state events;
- bound retained image payloads during UI history compaction;
- show a deterministic text placeholder when an image cannot be rendered.

Kitty deletion, resize-driven replacement, terminal cell pixel queries, and
global scroll lifecycle ownership remain out of scope.

## Data Flow

### Model output

`ServerGeminiContentEvent.value` remains the concatenated text consumed by
existing clients. When a response chunk contains image `inlineData`, the
event also carries an optional ordered `parts` field containing displayable
non-thought text and image parts.

Only the interactive TUI reads `parts`. It stages text and image history
items in their original order. A fresh retry or model fallback discards the
failed attempt's staged output, while a normal response boundary commits it.
Text-only events keep their existing runtime shape, so non-interactive output,
SDK, ACP, daemon, channel, Web UI, and VS Code consumers continue using
`value` unchanged.

Recorded assistant messages already retain their original parts. Resume logic
reconstructs ordered text/image runs instead of flattening images away.

### Tool output

Tool media is stored in `functionResponse.parts`. A CLI extractor reads image
`inlineData` from top-level and nested response parts. Live scheduler mapping
and resume mapping attach the images to the existing
`IndividualToolCallDisplay`.

Tools carrying images render individually even when their text-only form would
normally collapse into a read/search summary. `ToolMessage` routes the images
through the same `TerminalImage` component used by assistant messages.

## Rendering

The existing #8217 file-path entry point is unchanged. The shared renderer
adds an in-memory PNG entry point that:

1. validates bounded base64 before decoding;
2. verifies the PNG signature and IHDR dimensions;
3. rejects payloads above 8 MiB or dimensions above 1,000,000 pixels;
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

The first slice renders validated PNG data only. Other image MIME types remain
visible as deterministic placeholders rather than entering a second protocol
or decoding path.

## Memory

Encoded images are much larger than ordinary history text. UI compaction drops
payloads from old assistant image items while retaining the 20 most recent
items. Cleared images leave a visible marker instead of becoming blank rows.
Tool image payloads participate in the existing tool-result compaction limit.

## Test Plan

- Keep every #8217 renderer and `display_image` test green.
- Verify inline PNG validation, Kitty rendering, `chafa` stdin rendering,
  screen-reader output, and unavailable-renderer placeholders.
- Verify `Turn` preserves mixed `text -> image -> text` ordering while
  retaining the old `value` and text-only event shape.
- Verify live TUI ordering across retry, fallback, cancellation, stream
  boundaries, and goal-state events.
- Verify live and restored tool responses expose nested images.
- Verify restored assistant history preserves text/image ordering.
- Verify memory compaction clears old assistant and tool image payloads.
