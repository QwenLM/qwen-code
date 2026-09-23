# Terminal Inline Images E2E Plan

## Baseline

1. Start the interactive CLI from `main`.
2. Return an assistant response containing
   `text -> inlineData(image/png) -> text`.
3. Run a tool whose `functionResponse.parts` contains an `image/png`.
4. Confirm that `main` omits the assistant image and reduces tool media to
   text, while the separate `display_image` tool from #8217 can display a
   workspace PNG path.

The global `qwen` executable is unavailable in the current environment, so the
baseline is grounded in issue #8090 and the unchanged `main` event mapping.

## Verification

### Shared renderer regression

1. Ask the model to call `display_image` for a workspace PNG.
2. In direct Kitty or Ghostty, confirm the existing native preview still
   renders.
3. In a non-native terminal with `chafa` installed, confirm the existing ANSI
   preview still renders.
4. Confirm the file-path tool retains its workspace, file-size, and PNG
   validation behavior.

### Inline assistant and tool images

1. Return a 1x1 PNG between two assistant text parts.
2. Confirm the transcript order is `text -> image -> text`.
3. Return a PNG in a successful tool's top-level and nested
   `functionResponse.parts`.
4. Confirm the successful tool row retains its images.
5. Use `/resume` (or `--continue`) to resume the session; confirm successful tool image order is
   reconstructed from persisted parts. Assistant output resumes its persisted
   text; assistant inline images are not persisted by the current Core recorder.
6. Return six images in one assistant output and one tool response; confirm the
   first four render and the row ends with `[+2 more images]`.

### Kitty/Ghostty

1. Start the CLI in direct Kitty or Ghostty without tmux or SSH.
2. Repeat the assistant and tool cases.
3. Confirm inline PNGs use the same virtual placement and Unicode placeholders
   as `display_image`.
4. Confirm remounting a history row does not retransmit an already-written
   payload.

### chafa

1. Start the CLI in Warp, iTerm2, tmux, SSH, or another non-native environment
   with `chafa` installed.
2. Repeat the assistant and tool cases.
3. Confirm PNG bytes render as ANSI symbol rows and stay aligned during normal
   scrolling.
4. Confirm image data is supplied through stdin and no model-controlled value
   is used as a command argument.

### Placeholders and accessibility

1. Repeat without `chafa` and outside direct Kitty/Ghostty.
2. Confirm a valid PNG displays `[image: <width>x<height> png]`.
3. Repeat with malformed base64, a payload above 8 MiB, invalid IHDR
   dimensions, and a non-PNG MIME type.
4. Confirm no raw image sequence is written. Confirm the oversized payload is
   dropped before UI history, while admitted malformed/non-PNG data uses a
   deterministic placeholder.
5. Repeat with `--screen-reader` (or `ui.accessibility.screenReader: true`); confirm only the placeholder is
   emitted.

### Stream lifecycle

1. Exercise a fresh retry, continuation retry, model fallback, cancellation,
   stream boundary, tool call boundary, and displayed goal-state event.
2. Confirm fresh attempts discard all staged image/text runs from the failed
   attempt.
3. Confirm continuations preserve partial output.
4. Confirm every normal boundary commits earlier runs before later status or
   tool rows.

## Automated Evidence

Record final results for:

- focused CLI renderer, component, stream, tool, resume, and compaction tests;
- Core `Turn`, `display_image`, config, scheduler, and tool tests;
- `npm run lint:ci`;
- `npm run typecheck`;
- `npm run build`;
- `npm run check:serve-fast-path-bundle`.

Real-terminal output remains a reviewer hardware step when the local environment
has no Kitty/Ghostty session. Reusing #8217's renderer means its existing manual
Kitty, Ghostty, cmux, and Warp evidence continues to cover the terminal protocol
layer; this plan focuses new manual verification on the inline-data entry point
and transcript lifecycle.
