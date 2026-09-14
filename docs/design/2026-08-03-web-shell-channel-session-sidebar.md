# Web Shell channel sessions in the sidebar

[English](2026-08-03-web-shell-channel-session-sidebar.md) | [简体中文](2026-08-03-web-shell-channel-session-sidebar.zh-CN.md)

## Motivation

Daemon-managed channels create ordinary workspace sessions with
`sourceType: "channel"`, but the Web Shell sidebar intentionally requests only
the `default` session catalog. A session started from DingTalk, Feishu, or
another channel therefore cannot be opened from the sidebar even though it is
stored in the selected workspace.

## Design

Add a two-option source switch above the sidebar's project session list:

- **Tasks** requests `sourceType: "default"` and remains the initial selection.
  The daemon catalog includes default, legacy, and `qwen-live` sessions.
  Separately, the Sidebar adds sessions bound to durable scheduled tasks with
  a mode other than `per_run` to its ordinary task list; scheduled-task run
  history stays in its dedicated view.
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

When the selected workspace also advertises `channel_management`, the Channels
catalog joins each session's immutable channel instance name (`sourceId`) to
the current channel configuration and groups sessions by `config.type`. The
type catalog supplies the platform label, so multiple instances of the same
platform share one collapsible section. Sessions whose instance no longer
exists remain visible under Other channels. If the catalog is unavailable, the
list keeps its existing fallback instead of hiding sessions. Channel type grouping
overrides user-defined session groups in the Channels view; Tasks keeps its
existing organization behavior. Secondary workspaces resolve their own
workspace-scoped channel catalog.

Channel adapters still prepend their model-facing instructions and contextual
history. The daemon prompt carries the user-authored text separately as
transcript display metadata, so live and replayed Web Shell messages do not
expose that hidden context and channel session titles derive from the same
visible text.

## Boundaries

- Channel configuration and runtime management are unchanged.
- Persisted session source metadata is unchanged. The public daemon `default`
  filter now also matches `qwen-live`; other source filters stay exact, and an
  explicit `sourceId` remains an exact restriction within the selected catalog.
  The internal Conversations filter is unchanged.
- Session Overview, the Split View picker, and workspace total, running, and
  attention counts share the expanded default catalog, including `qwen-live`.
  Scheduled-task eligibility is unchanged. REST close, delete, and archive reject
  Live tasks with an attached client or active prompt.
- The switch is in-memory UI state and resets to Tasks on page reload.
- Channel type classification reflects the current workspace configuration;
  sessions do not persist a historical platform type.

## Verification

- Assert the source switch is gated by `session_source_metadata`.
- Assert Tasks is initially selected and requests `sourceType: "default"`.
- Assert selecting Channels requests `sourceType: "channel"` for primary and
  workspace-qualified lists.
- Assert the Channels list polls on the active-session interval.
- Assert multiple instances of one platform share a collapsible type section,
  other platform sessions remain separate, pinned sessions stay in their type
  section, and unmatched sessions remain under Other channels.
- Assert channel prompts preserve full model context while recording only the
  user-authored text for transcript display.
- Run the sidebar and workspace-section unit tests, Web Shell build, and
  TypeScript typecheck.
