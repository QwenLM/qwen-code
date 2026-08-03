# Web Shell channel sessions in the sidebar

## Motivation

Daemon-managed channels create ordinary workspace sessions with
`sourceType: "channel"`, but the Web Shell sidebar intentionally requests only
the `default` session catalog. A session started from DingTalk, Feishu, or
another channel therefore cannot be opened from the sidebar even though it is
stored in the selected workspace.

## Design

Add a two-option source switch above the sidebar's project session list:

- **Tasks** lists `sourceType: "default"` and remains the initial selection.
- **Channels** lists `sourceType: "channel"`.

The switch is shown only when the daemon advertises
`session_source_metadata`. Older daemons keep the current unfiltered request
and do not show a control they cannot support.

The selected source is applied consistently to active, pinned, archived, and
secondary-workspace session requests. Existing session rows, workspace
sections, grouping, search, polling, and open-session actions are reused.
Because channel sessions can be created by external messages without a Web
Shell mutation event, the expanded Channels list uses the active-session poll
interval instead of the 30-second idle interval.

Channel adapters still prepend their model-facing instructions and contextual
history. The daemon prompt carries the user-authored text separately as
transcript display metadata, so live and replayed Web Shell messages do not
expose that hidden context and channel session titles derive from the same
visible text.

## Boundaries

- Channel configuration and runtime management are unchanged.
- Session source metadata and daemon list APIs are unchanged.
- Session Overview and Split View keep their existing default-session scope.
- The switch is in-memory UI state and resets to Tasks on page reload.

## Verification

- Assert the source switch is gated by `session_source_metadata`.
- Assert Tasks is initially selected and requests `sourceType: "default"`.
- Assert selecting Channels requests `sourceType: "channel"` for primary and
  workspace-qualified lists.
- Assert the Channels list polls on the active-session interval.
- Assert channel prompts preserve full model context while recording only the
  user-authored text for transcript display.
- Run the sidebar and workspace-section unit tests, Web Shell build, and
  TypeScript typecheck.
